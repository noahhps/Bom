"""Your Claude plan, through Claude Code.

A backend that answers with the Claude subscription (Pro, Max, Team, ...) the
reader already has -- and the only way Bom may use one. Anthropic's terms are
specific about it (code.claude.com/docs/en/legal-and-compliance, "Authentication
and credential use"): a third-party app may not offer Claude.ai login, may not
route requests through plan credentials, and may not collect, store or pass
along Claude.ai tokens. What they do allow is the end user signing in to the
*unmodified* Claude Code binary with their own plan, including when another
program runs that binary. So that is all this module does:

* It runs the `claude` command the reader installed, as published, in print
  mode (`claude -p`). It never reads Claude Code's credentials, its keychain
  entry or its config, and never talks to Anthropic itself.
* Signing in happens in Claude Code, through Anthropic's own flow
  (`claude auth login` in a terminal). Bom only asks `claude auth status`
  whether that has been done, which answers with a method and a yes/no -- no
  token.
* Nothing is resold or shared: it is the reader's own plan, used by the reader,
  on the reader's machine. Usage counts against that plan's limits like any
  other Claude Code use.

How a turn runs. Bom's loop is stateless per round -- the orchestrator calls
`stream()` with the conversation and the skills, gets text and tool calls back,
runs the skills itself (approvals, canvas, events and all) and calls `stream()`
again with the results. Claude Code runs its own loop instead. The two meet
through MCP: the turn starts one `claude -p` process with Claude Code's own
tools switched off and Bom's skills offered as an MCP server served from this
process (ClaudeCodeBridge, on loopback, behind a per-turn secret). When Claude
calls a skill, the round ends here and the orchestrator runs it exactly as it
would for any backend; the next `stream()` call carries the result, which goes
back to the waiting `claude` process, and the same process carries on.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import shutil
import tempfile
import time
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .base import Chunk, Message, ProviderError, ToolCall

# The MCP server's name as Claude Code sees it, and so the prefix on every
# skill it calls: `mcp__bom__current_time`.
SERVER_NAME = "bom"
_PREFIX = f"mcp__{SERVER_NAME}__"

# Claude Code's model aliases. Each resolves to whatever that family's current
# model is for the signed-in account, so this list does not go stale the way a
# list of dated model ids would.
MODELS = (
    {"id": "sonnet", "name": "Sonnet", "note": "the everyday model"},
    {"id": "opus", "name": "Opus", "note": "the most capable"},
    {"id": "haiku", "name": "Haiku", "note": "the fastest"},
)

# Effort words Claude Code takes, out of the ones Bom's control offers.
_EFFORTS = {"low", "medium", "high"}

# How long a turn may sit waiting for the orchestrator to send a round's
# results back -- an approval prompt or the design chooser can keep it there
# while the reader decides -- before the process is let go.
_RESUME_TIMEOUT = 30 * 60

# How long `claude auth status` is believed for.
_STATUS_TTL = 30.0

# Earlier messages are carried into a new turn as a transcript; a long tool
# result is cut to this many characters there (the turn it ran in had it all).
_TRANSCRIPT_RESULT_CHARS = 1500


def find_claude() -> str | None:
    """The `claude` command to run: CLAUDE_CODE_BIN if set, else the one on PATH."""
    explicit = os.environ.get("CLAUDE_CODE_BIN", "").strip()
    if explicit:
        return explicit if Path(explicit).exists() else None
    return shutil.which("claude")


def _child_env() -> dict[str, str]:
    """The environment `claude` runs in.

    Without the Anthropic key variables: this backend is for the reader's
    plan, and a key in the server's environment (there for the Anthropic
    backend, perhaps) would make Claude Code bill the key instead. MCP tool
    calls get a long timeout, because one of Bom's skills may be waiting on
    the reader to approve it.
    """
    env = {
        key: value
        for key, value in os.environ.items()
        if key not in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")
    }
    env["MCP_TOOL_TIMEOUT"] = str(_RESUME_TIMEOUT * 1000)
    return env


# -- the bridge ---------------------------------------------------------------


@dataclass
class _Call:
    """One skill call: seen in Claude's message, answered by the orchestrator."""

    id: str
    name: str
    arguments: dict[str, Any]
    result: asyncio.Future = field(default_factory=lambda: asyncio.get_running_loop().create_future())
    claimed: bool = False  # matched to an MCP tools/call already


class ClaudeCodeBridge:
    """Bom's skills as an MCP server, for the `claude` processes this backend starts.

    Minimal Streamable HTTP: JSON-RPC over POST with plain JSON answers --
    initialize, tools/list, tools/call and ping are all Claude Code asks for.
    Each turn registers under a fresh 256-bit secret that is the whole URL
    path, and the route only answers loopback callers; the secret dies with
    the turn.
    """

    def __init__(self) -> None:
        self._turns: dict[str, _Turn] = {}

    def register(self, turn: "_Turn") -> str:
        token = secrets.token_urlsafe(32)
        self._turns[token] = turn
        return token

    def forget(self, token: str) -> None:
        self._turns.pop(token, None)

    async def handle(self, token: str, payload: Any) -> Any:
        """One POST: a JSON-RPC message (or a batch). None means 202 Accepted."""
        turn = self._turns.get(token)
        if turn is None:
            raise KeyError(token)
        if isinstance(payload, list):
            answers = [a for a in [await self._one(turn, m) for m in payload] if a is not None]
            return answers or None
        return await self._one(turn, payload)

    async def _one(self, turn: "_Turn", message: Any) -> dict | None:
        if not isinstance(message, dict):
            return _rpc_error(None, -32600, "not a JSON-RPC message")
        method = message.get("method")
        msg_id = message.get("id")
        if msg_id is None:
            return None  # a notification -- notifications/initialized and the like
        params = message.get("params") or {}
        if method == "initialize":
            return _rpc_result(msg_id, {
                "protocolVersion": params.get("protocolVersion") or "2025-06-18",
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": SERVER_NAME, "version": "1"},
            })
        if method == "ping":
            return _rpc_result(msg_id, {})
        if method == "tools/list":
            return _rpc_result(msg_id, {"tools": turn.mcp_tools})
        if method == "tools/call":
            name = str(params.get("name") or "")
            arguments = params.get("arguments") or {}
            content, is_error = await turn.call_from_claude(name, arguments)
            return _rpc_result(msg_id, {"content": content, "isError": is_error})
        return _rpc_error(msg_id, -32601, f"no method {method!r}")


def _rpc_result(msg_id: Any, result: Any) -> dict:
    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


def _rpc_error(msg_id: Any, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}


# -- one turn -----------------------------------------------------------------


class _Turn:
    """One `claude -p` process, alive from a user message to its answer.

    Its stdout and the bridge's tool calls both feed one queue, read by
    whichever `stream()` call is current; between rounds the process simply
    waits inside an MCP call for the orchestrator to come back with results.
    """

    def __init__(self, provider: "ClaudeCodeProvider", tools: Sequence[dict] | None) -> None:
        self.provider = provider
        self.events: asyncio.Queue = asyncio.Queue()
        self.mcp_tools = [
            {
                "name": t["name"],
                "description": t.get("description", ""),
                "inputSchema": t.get("parameters") or {"type": "object", "properties": {}},
            }
            for t in (tools or [])
        ]
        self.calls: dict[str, _Call] = {}  # by tool_use id, this round and earlier
        self.round: list[_Call] = []  # seen in Claude's messages since the last round ended
        self.token: str | None = None
        self.proc: asyncio.subprocess.Process | None = None
        self.reader: asyncio.Task | None = None
        self.watchdog: asyncio.Task | None = None
        self.stderr_tail: list[str] = []
        self.finished = False
        self.workdir: tempfile.TemporaryDirectory | None = None

    # The bridge's side: Claude asks for a skill.
    async def call_from_claude(self, name: str, arguments: dict) -> tuple[list[dict], bool]:
        bare = name[len(_PREFIX):] if name.startswith(_PREFIX) else name
        call = self._claim(bare, arguments)
        if call is None:
            # Not one Claude announced yet -- its message is read off stdout,
            # which can lag this HTTP request by a few milliseconds.
            for _ in range(100):
                await asyncio.sleep(0.02)
                call = self._claim(bare, arguments)
                if call is not None:
                    break
        if call is None:
            return [{"type": "text", "text": f"{bare} could not be matched to a call."}], True
        # Tells the current round it can end: Claude is now waiting on Bom.
        await self.events.put(("mcp_call", call.id))
        try:
            text, images = await asyncio.wait_for(asyncio.shield(call.result), _RESUME_TIMEOUT)
        except asyncio.TimeoutError:
            return [{"type": "text", "text": f"{bare} got no answer in time."}], True
        content: list[dict] = [{"type": "text", "text": text or "(no output)"}]
        for image in images:
            content.append({"type": "image", "data": image.b64(), "mimeType": image.mime})
        return content, False

    def _claim(self, name: str, arguments: dict) -> _Call | None:
        """The announced call this MCP request is: same name and arguments,
        else the first of that name -- in the order Claude announced them."""
        open_calls = [c for c in self.calls.values() if not c.claimed and c.name == name]
        exact = next((c for c in open_calls if c.arguments == arguments), None)
        call = exact or (open_calls[0] if open_calls else None)
        if call is not None:
            call.claimed = True
        return call

    def answer(self, results: dict[str, tuple[str, tuple]]) -> None:
        for call_id, value in results.items():
            call = self.calls.get(call_id)
            if call is not None and not call.result.done():
                call.result.set_result(value)
        if self.watchdog:
            self.watchdog.cancel()
            self.watchdog = None

    def waiting_on(self) -> set[str]:
        return {i for i, c in self.calls.items() if not c.result.done()}

    async def start(self, messages: Sequence[Message], *, think: str | None) -> None:
        claude = find_claude()
        if not claude:
            raise ProviderError(
                "Claude Code isn't installed on the machine running Bom. Install it "
                "(code.claude.com), sign in with `claude auth login`, then try again."
            )
        self.workdir = tempfile.TemporaryDirectory(prefix="bom-claude-")
        system = "\n\n".join(m.content for m in messages if m.role == "system")
        prompt_file = Path(self.workdir.name) / "system.md"
        prompt_file.write_text(system or "You are a helpful assistant.", encoding="utf-8")

        args = [
            claude, "-p",
            "--output-format", "stream-json", "--verbose", "--include-partial-messages",
            "--input-format", "stream-json",
            "--model", self.provider.model or "sonnet",
            "--system-prompt-file", str(prompt_file),
            # Claude Code's own tools off: Bom's skills are the tools here.
            "--tools", "",
            "--disable-slash-commands",
            "--no-session-persistence",
            # Anything not explicitly allowed is refused rather than asked.
            "--permission-mode", "dontAsk",
        ]
        if think in _EFFORTS:
            args += ["--effort", think]
        if self.mcp_tools:
            self.token = self.provider.bridge.register(self)
            config = {"mcpServers": {SERVER_NAME: {"type": "http", "url": self.provider.bridge_url(self.token)}}}
            args += [
                "--strict-mcp-config", "--mcp-config", json.dumps(config),
                "--allowedTools", f"mcp__{SERVER_NAME}",
            ]
        else:
            args += ["--strict-mcp-config"]

        # A folder of its own, so no project's CLAUDE.md, settings or .mcp.json
        # is picked up from wherever the server happens to have been started.
        cwd = self.provider.workdir()
        try:
            self.proc = await asyncio.create_subprocess_exec(
                *args,
                cwd=str(cwd),
                env=_child_env(),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                limit=16 * 1024 * 1024,
            )
        except OSError as exc:
            self.close()
            raise ProviderError(f"couldn't start Claude Code: {exc}") from exc

        self.proc.stdin.write((json.dumps(_user_message(messages)) + "\n").encode("utf-8"))
        await self.proc.stdin.drain()
        # One message per turn: closing stdin lets the run end when it is done.
        self.proc.stdin.close()
        self.reader = asyncio.create_task(self._read())

    async def _read(self) -> None:
        assert self.proc is not None
        stderr_task = asyncio.create_task(self._read_stderr())
        try:
            async for raw in self.proc.stdout:
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                # Skill calls are registered here, as they are read, rather
                # than when a round gets to them: the bridge may already be
                # holding Claude's request for one.
                if event.get("type") == "assistant":
                    self._register_calls(event)
                await self.events.put(("event", event))
        finally:
            await self.proc.wait()
            await stderr_task
            await self.events.put(("exit", self.proc.returncode))

    async def _read_stderr(self) -> None:
        assert self.proc is not None
        async for raw in self.proc.stderr:
            self.stderr_tail = (self.stderr_tail + [raw.decode("utf-8", "replace").rstrip()])[-20:]

    def _register_calls(self, event: dict) -> None:
        message = event.get("message") or {}
        for block in message.get("content") or []:
            if block.get("type") != "tool_use":
                continue
            name = str(block.get("name") or "")
            if not name.startswith(_PREFIX) or block.get("id") in self.calls:
                continue
            call = _Call(id=str(block["id"]), name=name[len(_PREFIX):], arguments=dict(block.get("input") or {}))
            self.calls[call.id] = call
            self.round.append(call)

    async def pump(self) -> AsyncIterator[Chunk]:
        """Read until the round ends -- Claude waits on a skill -- or the answer does."""
        while True:
            kind, value = await self.events.get()
            if kind == "mcp_call":
                # The round ends when Claude is waiting on a call this round
                # announced and Bom has not answered. Every call announced so
                # far goes together, so parallel calls make one round.
                call = self.calls.get(value)
                if call is not None and call in self.round and not call.result.done():
                    calls = tuple(ToolCall(id=c.id, name=c.name, arguments=c.arguments) for c in self.round)
                    self.round = []
                    self._arm_watchdog()
                    yield Chunk(done=True, tool_calls=calls)
                    return
            elif kind == "event":
                chunk = self._chunk_for(value)
                if chunk is not None:
                    if chunk.done:
                        self.finished = True
                        yield chunk
                        self.close()
                        return
                    yield chunk
            elif kind == "exit":
                self.finished = True
                self.close()
                raise ProviderError(self._exit_reason(value))

    def _chunk_for(self, event: dict) -> Chunk | None:
        kind = event.get("type")
        if kind == "stream_event":
            delta = (event.get("event") or {}).get("delta") or {}
            if delta.get("type") == "text_delta" and delta.get("text"):
                return Chunk(text=delta["text"])
            if delta.get("type") == "thinking_delta" and delta.get("thinking"):
                return Chunk(thinking=delta["thinking"])
            return None
        if kind == "assistant":
            # Text arrived as deltas already, and its skill calls were
            # registered as the line was read (_register_calls).
            return None
        if kind == "system" and event.get("subtype") == "init" and self.mcp_tools:
            # Claude Code carries on without a server it could not reach, which
            # would be a turn with none of Bom's skills and no word of why.
            servers = {s.get("name"): s.get("status") for s in event.get("mcp_servers") or []}
            if servers.get(SERVER_NAME) == "failed":
                raise ProviderError(
                    "Claude Code couldn't reach Bom's skills (the MCP bridge at "
                    f"{self.provider.bridge_url('…')}). Check BIND_HOST and BIND_PORT."
                )
            return None
        if kind == "system" and event.get("subtype") == "api_retry":
            if event.get("error") in ("authentication_failed", "oauth_org_not_allowed", "account_on_hold", "billing_error"):
                raise ProviderError(_auth_message(event.get("error")))
            return None
        if kind == "result":
            if event.get("is_error") or str(event.get("subtype", "")).startswith("error"):
                raise ProviderError(_result_message(event))
            usage = event.get("usage") or {}
            read = int(usage.get("cache_read_input_tokens") or 0)
            wrote = int(usage.get("cache_creation_input_tokens") or 0)
            prompt = int(usage.get("input_tokens") or 0) + read + wrote
            return Chunk(
                done=True,
                prompt_tokens=prompt or None,
                completion_tokens=usage.get("output_tokens"),
                meta={k: v for k, v in (("cache_read_tokens", read), ("cache_write_tokens", wrote)) if v},
            )
        return None

    def _exit_reason(self, code: int | None) -> str:
        tail = " ".join(line for line in self.stderr_tail if line).strip()
        if "login" in tail.lower() or "not logged in" in tail.lower():
            return _auth_message("authentication_failed")
        return f"Claude Code stopped (exit {code}){': ' + tail[-300:] if tail else ''}"

    def _arm_watchdog(self) -> None:
        if self.watchdog:
            self.watchdog.cancel()

        async def expire() -> None:
            await asyncio.sleep(_RESUME_TIMEOUT)
            self.close()

        self.watchdog = asyncio.create_task(expire())

    def close(self) -> None:
        if self.watchdog:
            self.watchdog.cancel()
            self.watchdog = None
        if self.token:
            self.provider.bridge.forget(self.token)
            self.token = None
        for call in self.calls.values():
            if not call.result.done():
                call.result.set_result(("The conversation moved on before this ran.", ()))
        self.provider.turns.discard(self)
        if self.proc and self.proc.returncode is None:
            try:
                self.proc.terminate()
            except ProcessLookupError:
                pass
        if self.workdir is not None:
            self.workdir.cleanup()
            self.workdir = None


def _auth_message(error: str | None) -> str:
    if error == "billing_error":
        return "Claude Code reported a billing problem with your plan. Check claude.ai/settings."
    if error == "account_on_hold":
        return "Your Claude account is on hold, so Claude Code can't answer."
    return (
        "Claude Code isn't signed in to your Claude plan. Run `claude auth login` in a "
        "terminal on the machine running Bom, then try again."
    )


def _result_message(event: dict) -> str:
    text = str(event.get("result") or "").strip()
    lowered = text.lower()
    if "login" in lowered or "not logged in" in lowered or "invalid api key" in lowered:
        return _auth_message("authentication_failed")
    if "limit" in lowered and ("usage" in lowered or "reset" in lowered):
        return f"Your Claude plan's usage limit was reached: {text}"
    return text or f"Claude Code ended the turn with {event.get('subtype') or 'an error'}"


def _user_message(messages: Sequence[Message]) -> dict:
    """The one stream-json user message a turn starts with.

    Bom owns the conversation, so earlier messages ride along as a transcript
    ahead of the newest message rather than as a resumed Claude Code session --
    an edited or compacted history here then needs nothing reconciled there.
    """
    convo = [m for m in messages if m.role != "system"]
    last_user = max((i for i, m in enumerate(convo) if m.role == "user"), default=None)
    earlier = convo[:last_user] if last_user is not None else convo
    newest = convo[last_user] if last_user is not None else Message(role="user", content="")

    blocks: list[dict] = []
    transcript = _transcript(earlier)
    if transcript:
        blocks.append({
            "type": "text",
            "text": "The conversation so far, for context:\n<conversation>\n"
            f"{transcript}\n</conversation>\n\nThe newest message, which you are answering:",
        })
    for image in newest.images:
        blocks.append({"type": "image", "source": {"type": "base64", "media_type": image.mime, "data": image.b64()}})
    blocks.append({"type": "text", "text": newest.content or "(see the attached image)"})
    return {"type": "user", "message": {"role": "user", "content": blocks}}


def _transcript(messages: Sequence[Message]) -> str:
    lines: list[str] = []
    for m in messages:
        if m.role == "user":
            lines.append(f"User: {m.content}")
        elif m.role == "assistant":
            if m.content:
                lines.append(f"Assistant: {m.content}")
            for call in m.tool_calls:
                lines.append(f"Assistant used {call.name} with {json.dumps(call.arguments)[:400]}")
        elif m.role == "tool":
            result = m.content if len(m.content) <= _TRANSCRIPT_RESULT_CHARS else m.content[:_TRANSCRIPT_RESULT_CHARS] + " …"
            lines.append(f"{m.tool_name or 'Tool'} returned: {result}")
    return "\n\n".join(lines)


# -- the provider -------------------------------------------------------------


class ClaudeCodeProvider:
    """The backend: Bom's side of each `claude -p` turn."""

    def __init__(self, *, data_dir: Path, bind_host: str, bind_port: int, context_tokens: int = 200_000) -> None:
        self.name = "claude-code"
        self.model = "sonnet"
        self.context_tokens = context_tokens
        self.bridge = ClaudeCodeBridge()
        self.turns: set[_Turn] = set()
        self._data_dir = data_dir
        host = bind_host if bind_host not in ("", "0.0.0.0", "::") else "127.0.0.1"
        self._bridge_base = f"http://{'[' + host + ']' if ':' in host else host}:{bind_port}"
        self._status: tuple[float, dict] | None = None

    @property
    def configured(self) -> bool:
        return find_claude() is not None

    def bridge_url(self, token: str) -> str:
        return f"{self._bridge_base}/api/claude-code/mcp/{token}"

    def workdir(self) -> Path:
        path = self._data_dir / "claude-code"
        path.mkdir(parents=True, exist_ok=True)
        return path

    async def auth_status(self, *, fresh: bool = False) -> dict:
        """What `claude auth status` says: installed, signed in, and how.

        Only the fields worth showing are kept. The command reports a method,
        not a credential, and nothing here reads Claude Code's own files.
        """
        if not fresh and self._status and time.monotonic() - self._status[0] < _STATUS_TTL:
            return self._status[1]
        claude = find_claude()
        status: dict = {"installed": bool(claude), "logged_in": False, "method": "none", "version": ""}
        if claude:
            # "2.1.316 (Claude Code)" -- the number is the part worth showing.
            status["version"] = (await _run_text([claude, "--version"])).split(" ")[0]
            raw = await _run_text([claude, "auth", "status"])
            try:
                parsed = json.loads(raw)
            except ValueError:
                parsed = {}
            status["logged_in"] = bool(parsed.get("loggedIn"))
            status["method"] = str(parsed.get("authMethod") or "none")
        self._status = (time.monotonic(), status)
        return status

    async def health(self) -> bool:
        status = await self.auth_status()
        return status["installed"] and status["logged_in"]

    async def list_models(self) -> list[dict]:
        return [dict(m) for m in MODELS]

    async def context_window(self) -> int:
        return self.context_tokens

    async def sees_images(self) -> bool:
        return True

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        raise ProviderError("Claude Code has no embedding model")

    def _resumable(self, messages: Sequence[Message]) -> tuple[_Turn, dict] | None:
        """The live turn these messages continue, and the results they carry.

        A continuation ends in the round's tool results -- possibly followed by
        a user message carrying the pictures a result produced -- whose ids are
        the calls a live turn is waiting on.
        """
        results: dict[str, tuple[str, tuple]] = {}
        pictures: tuple = ()
        for m in reversed(messages):
            if m.role == "tool" and m.tool_call_id:
                results[m.tool_call_id] = (m.content, ())
            elif m.role == "user" and m.images and not results:
                pictures = m.images
            else:
                break
        if not results:
            return None
        for turn in self.turns:
            if turn.waiting_on() & results.keys():
                if pictures:
                    last = next(iter(results))
                    results[last] = (results[last][0], pictures)
                return turn, results
        return None

    async def stream(
        self,
        messages: Sequence[Message],
        *,
        think: str | None = None,
        tools: Sequence[dict] | None = None,
    ) -> AsyncIterator[Chunk]:
        resumed = self._resumable(messages)
        if resumed is not None:
            turn, results = resumed
            turn.answer(results)
        else:
            turn = _Turn(self, tools)
            self.turns.add(turn)
            await turn.start(messages, think=think)

        ended = False
        try:
            async for chunk in turn.pump():
                if chunk.done:
                    ended = True
                yield chunk
        finally:
            # Stopped part way -- the reader pressed Stop, or the turn failed
            # upstream -- rather than at a round's end: let the process go.
            if not ended:
                turn.close()

    async def aclose(self) -> None:
        for turn in list(self.turns):
            turn.close()


async def _run_text(args: list[str], timeout: float = 15.0) -> str:
    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env=_child_env(),
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
        return out.decode("utf-8", "replace").strip()
    except (OSError, asyncio.TimeoutError):
        return ""
