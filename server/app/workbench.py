"""The Code view's workbench: terminals, and a preview of the project.

Terminals are real shells on real pseudo-terminals, one per tab, started in
the project folder with the reader's own login shell -- the same thing
Terminal.app would give them, streamed to xterm.js over a WebSocket. A shell
outlives the socket that opened it: reload the page, move the Code view to its
own window, and the tab reattaches to the same shell with what it printed
since. That is what lets a dev server keep running while the preview shows it.
A shell ends when its tab is closed, when it exits, or when the server stops.

A terminal is a shell on this machine, so it is only offered to this machine:
a connection from anywhere else is refused unless TERMINAL_REMOTE says
otherwise, whatever token it holds.

The preview serves a project's own files -- for a page with no build step --
under an unguessable key, so an iframe, which cannot send the bearer header,
can load it. Keys live in memory and die with the server. Everything is served
with `Access-Control-Allow-Origin: *` because the frame is sandboxed without
same-origin (it must never read the app's storage, where the token lives), and
a module script from an opaque origin is a cross-origin request.
"""

from __future__ import annotations

import asyncio
import codecs
import contextlib
import fcntl
import hmac
import mimetypes
import os
import secrets
import signal
import struct
import termios
import time
import uuid
import warnings
from pathlib import Path

from fastapi import APIRouter, Depends, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import workspace as project
from .code_mode import SECRET_ENV, command_shell

#: What a reattaching tab is sent of what it missed.
SCROLLBACK = 200_000
#: At most this many shells at once, across every project.
MAX_TERMINALS = 16
LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost", "testclient"}


class TerminalError(Exception):
    pass


class Terminal:
    """One shell on one pseudo-terminal."""

    def __init__(self, root: Path, cols: int = 80, rows: int = 24) -> None:
        self.id = "term_" + uuid.uuid4().hex[:16]
        self.root = root
        self.shell = command_shell()
        self.title = Path(self.shell).name
        self.created = time.time()
        self.buffer = ""
        self.exit_code: int | None = None
        self._listeners: set[asyncio.Queue] = set()
        self._decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self._loop = asyncio.get_running_loop()

        env = {k: v for k, v in os.environ.items() if k not in SECRET_ENV}
        env.update({"TERM": "xterm-256color", "COLORTERM": "truecolor", "TERM_PROGRAM": "Bom"})
        env.pop("PAGER", None)
        env.pop("GIT_PAGER", None)

        # fork-then-exec straight away: the child touches nothing but chdir and
        # execve, which is the one use of fork a threaded process can make.
        import pty

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            pid, fd = pty.fork()
        if pid == 0:  # pragma: no cover -- the child
            try:
                os.chdir(root)
                # A login shell, so PATH is the reader's own -- Homebrew,
                # nvm, pyenv -- and not the server's.
                os.execvpe(self.shell, [self.shell, "-l"], env)
            finally:
                os._exit(127)
        self.pid = pid
        self.fd = fd
        self.resize(cols, rows)
        os.set_blocking(fd, False)
        self._loop.add_reader(fd, self._readable)

    @property
    def alive(self) -> bool:
        return self.exit_code is None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "root": str(self.root),
            "title": self.title,
            "alive": self.alive,
            "exit_code": self.exit_code,
            "created": self.created,
        }

    # -- output ---------------------------------------------------------------

    def _readable(self) -> None:
        try:
            data = os.read(self.fd, 65536)
        except BlockingIOError:
            return
        except OSError:
            data = b""
        if not data:
            self._ended()
            return
        text = self._decoder.decode(data)
        if not text:
            return
        self.buffer = (self.buffer + text)[-SCROLLBACK:]
        for queue in list(self._listeners):
            queue.put_nowait(("output", text))

    def _ended(self, tries: int = 0) -> None:
        """The terminal closed: the shell has exited, or is about to. Its
        status is collected a moment later when it is not there yet, rather
        than reported as unknown."""
        if tries == 0:
            with contextlib.suppress(Exception):
                self._loop.remove_reader(self.fd)
        code = self._reap()
        if code is None and tries < 20:
            self._loop.call_later(0.05, self._ended, tries + 1)
            return
        self.exit_code = code if code is not None else -1
        for queue in list(self._listeners):
            queue.put_nowait(("exit", self.exit_code))

    def _reap(self, block: bool = False) -> int | None:
        try:
            pid, status = os.waitpid(self.pid, 0 if block else os.WNOHANG)
        except ChildProcessError:
            return -1
        if pid == 0:
            return None
        return os.waitstatus_to_exitcode(status)

    def attach(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue()
        self._listeners.add(queue)
        return queue

    def detach(self, queue: asyncio.Queue) -> None:
        self._listeners.discard(queue)

    # -- input ------------------------------------------------------------------

    async def write(self, text: str) -> None:
        if not self.alive:
            return
        data = text.encode("utf-8")
        while data:
            try:
                sent = os.write(self.fd, data)
                data = data[sent:]
            except BlockingIOError:
                # A long paste into a busy program: wait for the kernel buffer.
                await asyncio.sleep(0.01)
            except OSError:
                return

    def resize(self, cols: int, rows: int) -> None:
        cols = max(2, min(int(cols or 80), 1000))
        rows = max(1, min(int(rows or 24), 500))
        with contextlib.suppress(OSError):
            fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def close(self) -> None:
        """Hang the shell up, and everything it started with it."""
        if self.alive:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(self.pid, signal.SIGHUP)
        with contextlib.suppress(Exception):
            self._loop.remove_reader(self.fd)
        with contextlib.suppress(OSError):
            os.close(self.fd)
        if self.alive:
            code = self._reap()
            if code is None:
                # Still there a moment later: not waiting on a program that
                # ignores the hangup.
                def force() -> None:
                    if self._reap() is None:
                        with contextlib.suppress(ProcessLookupError, PermissionError):
                            os.killpg(self.pid, signal.SIGKILL)
                        self._loop.call_later(0.5, self._reap)

                with contextlib.suppress(RuntimeError):  # the loop has gone
                    self._loop.call_later(1.0, force)
            self.exit_code = code if code is not None else -1
        for queue in list(self._listeners):
            queue.put_nowait(("exit", self.exit_code))


class Terminals:
    """Every open shell, by id."""

    def __init__(self) -> None:
        self._all: dict[str, Terminal] = {}

    def open(self, root: Path, cols: int = 80, rows: int = 24) -> Terminal:
        self._prune()
        if len(self._all) >= MAX_TERMINALS:
            raise TerminalError(
                f"{MAX_TERMINALS} terminals are open already -- close one first."
            )
        term = Terminal(root, cols, rows)
        self._all[term.id] = term
        return term

    def get(self, term_id: str) -> Terminal | None:
        return self._all.get(term_id)

    def in_folder(self, root: Path) -> list[Terminal]:
        self._prune()
        return sorted(
            (t for t in self._all.values() if t.root == root), key=lambda t: t.created
        )

    def close(self, term_id: str) -> bool:
        term = self._all.pop(term_id, None)
        if term is None:
            return False
        term.close()
        return True

    def close_all(self) -> None:
        for term_id in list(self._all):
            self.close(term_id)

    def _prune(self) -> None:
        """Shells that exited with no tab left watching them."""
        for term_id, term in list(self._all.items()):
            if not term.alive and not term._listeners:
                self._all.pop(term_id, None)
                with contextlib.suppress(OSError):
                    os.close(term.fd)


class Previews:
    """Unguessable keys for serving project folders to a sandboxed frame."""

    def __init__(self) -> None:
        self._roots: dict[str, Path] = {}
        self._keys: dict[Path, str] = {}

    def key_for(self, root: Path) -> str:
        key = self._keys.get(root)
        if key is None:
            key = secrets.token_urlsafe(18)
            self._keys[root] = key
            self._roots[key] = root
        return key

    def root_for(self, key: str) -> Path | None:
        return self._roots.get(key)


# -- routes -----------------------------------------------------------------------


class TerminalList(BaseModel):
    root: str = Field(min_length=1, max_length=4096)


def build_workbench_router(settings, auth, terminals: Terminals, previews: Previews) -> APIRouter:
    """The authenticated half: listing and closing shells, and preview keys."""
    router = APIRouter(dependencies=[Depends(auth)])

    def _root(root: str) -> Path:
        try:
            return project.validate_root(root, settings.workspace_roots)
        except project.WorkspaceError as exc:
            raise HTTPException(400, str(exc)) from None

    @router.get("/terminals")
    def list_terminals(root: str) -> dict:
        return {"terminals": [t.to_dict() for t in terminals.in_folder(_root(root))]}

    @router.delete("/terminals/{term_id}")
    def close_terminal(term_id: str) -> dict:
        if not terminals.close(term_id):
            raise HTTPException(404, "no such terminal")
        return {"ok": True}

    @router.post("/workspace/preview")
    def preview_key(body: TerminalList) -> dict:
        """A path that serves this project's files, for the preview frame."""
        root = _root(body.root)
        key = previews.key_for(root)
        entry = next(
            (name for name in ("index.html", "public/index.html", "dist/index.html", "build/index.html")
             if (root / name).is_file()),
            None,
        )
        return {"base": f"/api/preview/{key}/", "entry": entry}

    return router


def _is_local(ws: WebSocket) -> bool:
    host = (ws.client.host if ws.client else "") or ""
    return host in LOCAL_HOSTS or host.startswith("127.")


def mount_public(app: FastAPI, settings, terminals: Terminals, previews: Previews) -> None:
    """The half that cannot carry the bearer header: the terminal's socket,
    which checks the token as its first message, and the preview's files,
    which are guarded by their key."""

    @app.websocket("/api/terminal")
    async def terminal_socket(ws: WebSocket) -> None:
        await ws.accept()

        async def fail(message: str) -> None:
            with contextlib.suppress(Exception):
                await ws.send_json({"type": "error", "message": message})
                await ws.close(code=1008)

        if not _is_local(ws) and not getattr(settings, "terminal_remote", False):
            await fail(
                "The terminal is only available on the computer Bom runs on. "
                "Set TERMINAL_REMOTE=1 on the server to allow it from other devices."
            )
            return
        try:
            hello = await asyncio.wait_for(ws.receive_json(), timeout=10)
        except (asyncio.TimeoutError, WebSocketDisconnect, ValueError):
            await fail("No token was sent.")
            return
        token = str(hello.get("token") or "")
        if not token or not hmac.compare_digest(token, settings.auth_token):
            await fail("That token was rejected.")
            return

        cols, rows = hello.get("cols") or 80, hello.get("rows") or 24
        term = terminals.get(str(hello.get("id") or "")) if hello.get("id") else None
        if term is None:
            try:
                root = project.validate_root(str(hello.get("root") or ""), settings.workspace_roots)
                term = terminals.open(root, cols, rows)
            except (project.WorkspaceError, TerminalError, OSError) as exc:
                await fail(str(exc))
                return
        else:
            term.resize(cols, rows)

        queue = term.attach()
        try:
            await ws.send_json({"type": "ready", **term.to_dict()})
            if term.buffer:
                await ws.send_json({"type": "output", "data": term.buffer})
            if not term.alive:
                await ws.send_json({"type": "exit", "code": term.exit_code})

            async def pump() -> None:
                while True:
                    kind, value = await queue.get()
                    if kind == "output":
                        # Everything already waiting goes as one message: a
                        # build log arrives as a few frames, not thousands.
                        chunks = [value]
                        while not queue.empty():
                            more_kind, more = queue.get_nowait()
                            if more_kind != "output":
                                await ws.send_json({"type": "output", "data": "".join(chunks)})
                                chunks = []
                                await ws.send_json({"type": "exit", "code": more})
                                break
                            chunks.append(more)
                        if chunks:
                            await ws.send_json({"type": "output", "data": "".join(chunks)})
                    else:
                        await ws.send_json({"type": "exit", "code": value})

            sender = asyncio.create_task(pump())
            try:
                while True:
                    message = await ws.receive_json()
                    kind = message.get("type")
                    if kind == "input":
                        await term.write(str(message.get("data") or ""))
                    elif kind == "resize":
                        term.resize(message.get("cols"), message.get("rows"))
                    elif kind == "close":
                        terminals.close(term.id)
                        break
            except (WebSocketDisconnect, RuntimeError, ValueError):
                pass
            finally:
                sender.cancel()
        finally:
            term.detach(queue)

    @app.get("/api/preview/{key}/{path:path}")
    async def preview_file(key: str, path: str = "") -> FileResponse:
        root = previews.root_for(key)
        if root is None:
            raise HTTPException(404, "This preview has expired -- open it again from the Code view.")
        try:
            target = project.inside(root, path or ".")
        except project.WorkspaceError:
            raise HTTPException(404, "not found") from None
        if target.is_dir():
            target = target / "index.html"
        if (
            not target.is_file()
            or project.in_git_dir(root, target)
            or any(part in project.SENSITIVE for part in target.relative_to(root).parts)
        ):
            raise HTTPException(404, "not found")
        media = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if target.suffix in (".js", ".mjs"):
            media = "text/javascript"
        return FileResponse(
            target,
            media_type=media,
            headers={
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            },
        )
