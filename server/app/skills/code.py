"""The code tools: explore, read, edit, write and run, in one project folder.

The shape of these follows the tools a coding agent is usually given -- list,
glob, grep, read, edit, write, a shell and a task list -- because that is the
vocabulary current models already work in, and a model that has to learn a new
one spends its turn on the tools instead of the code.

Offered only in a code conversation (`modes`), and only ever against the folder
the reader opened for it: every path goes through `workspace.inside`, and the
folder itself is checked again on every call, so one moved or deleted since is
an error, not a surprise.

Three rules carry the safety of editing:

* **read before you change.** code_edit and code_write refuse a file the model
  has not read in this conversation, or one that changed since it did -- the
  reader may have edited it in the editor a moment ago, and a write made from a
  stale copy would silently undo that.
* **edits are exact and all-or-nothing.** An old_string must match the file
  exactly and once (or `replace_all`); if any edit in a call misses, nothing is
  written, and the miss is reported with the closest text so the next attempt
  can copy it.
* **changes are asked for.** Edits, writes and commands go through the approval
  prompt; "Allow in this chat" is the equivalent of accepting edits for the rest
  of the conversation.
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import signal
from pathlib import Path

from .. import workspace as ws
from ..code_mode import SECRET_ENV, command_shell
from ..store import Store
from .args import as_dict, plain_text
from .patch import closest
from .skill import CODE_ONLY, Skill, Touched

MAX_LINE = 2_000
READ_LINES = 2_000
GLOB_LIMIT = 200
TODO_STATES = ("pending", "in_progress", "completed")

# Names the app uses for its own secrets, dropped from what a command sees.
# Hygiene rather than a boundary -- see skills/sandbox.py.


class CodeState:
    """What each code conversation has read, and its task list.

    In memory, like the approval grants: a read is evidence about a file at a
    moment, and after a restart the honest answer is "read it again".
    """

    def __init__(self) -> None:
        self._reads: dict[str, dict[str, int]] = {}
        self.todos: dict[str, list[dict]] = {}

    def saw(self, session: str, path: Path) -> None:
        try:
            stamp = path.stat().st_mtime_ns
        except OSError:
            return
        self._reads.setdefault(session, {})[str(path)] = stamp

    def fresh(self, session: str, path: Path) -> bool:
        """Whether the model's copy of `path` is the file as it is now."""
        seen = self._reads.get(session, {}).get(str(path))
        if seen is None:
            return False
        try:
            return path.stat().st_mtime_ns == seen
        except OSError:
            return False


class _Code(Skill):
    wants_session = True
    modes = CODE_ONLY

    def __init__(self, store: Store, settings, state: CodeState, **kwargs) -> None:
        super().__init__(**kwargs)
        self.store = store
        self.settings = settings
        self.state = state

    def root(self, session: str) -> Path:
        folder = self.store.session_workspace(session)
        if not folder:
            raise ws.WorkspaceError(
                "No project folder is open for this conversation. Ask the user to "
                "open one in the Code view, or offer to make a new one with "
                "create_code_project."
            )
        return ws.validate_root(folder, self.settings.workspace_roots)

    @property
    def limit(self) -> int:
        return int(getattr(self.settings, "code_output_chars", 30_000))

    @property
    def max_result_chars(self) -> int:
        # The turn loop cuts every result to RESULT_CHARS unless the skill
        # says otherwise, and it cuts from the end. Without this, a command's
        # output -- clipped here to its head *and* its tail, because a failing
        # test's summary is at the end -- lost the tail again on the way to the
        # model, and a code_read lost its "read on with offset=" line. The
        # margin covers the header and footer a result carries.
        return self.limit + 2_000

    async def use(self, session: str, **arguments) -> str:
        try:
            return await self.run(session, self.root(session), **arguments)
        except ws.WorkspaceError as exc:
            return str(exc)

    async def run(self, session: str, root: Path, **arguments) -> str:  # pragma: no cover
        raise NotImplementedError


def _numbered(lines: list[str], first: int) -> str:
    """Lines as `cat -n` prints them, so a model can cite path:line."""
    return "\n".join(
        f"{first + i:>6}\t{line[:MAX_LINE]}" + ("…" if len(line) > MAX_LINE else "")
        for i, line in enumerate(lines)
    )


def _clip(text: str, limit: int) -> str:
    """The head and the tail of a long output: a failing test's summary is at
    the end, and what it was running is at the start."""
    if len(text) <= limit:
        return text
    head = text[: limit * 2 // 3]
    tail = text[-(limit // 3):]
    return f"{head}\n\n… [{len(text) - len(head) - len(tail)} characters cut] …\n\n{tail}"


def _as_int(value, default: int) -> int:
    try:
        return int(plain_text(value) if not isinstance(value, int) else value)
    except (TypeError, ValueError):
        return default


# -- exploring ------------------------------------------------------------------


class CodeLs(_Code):
    def __init__(self, store, settings, state) -> None:
        super().__init__(
            store, settings, state,
            name="code_ls",
            description=(
                "List a folder in the project, two levels deep: folders end in "
                "/, and dependency and build folders are marked (ignored) and "
                "not expanded. Call with no path for the project root."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "A folder, relative to the project root."},
                },
            },
        )

    async def run(self, session, root, path=".", **extra) -> str:
        folder = ws.inside(root, plain_text(path) or ".")
        lines: list[str] = []
        count = 0

        cap = max(1, int(getattr(self.settings, "code_ls_limit", 400)))

        def walk(where: Path, depth: int) -> None:
            nonlocal count
            for entry in ws.list_dir(root, ws.relative(root, where)):
                if count >= cap:
                    return
                count += 1
                indent = "  " * depth
                if entry["kind"] == "dir":
                    note = " (ignored)" if entry["ignored"] else ""
                    lines.append(f"{indent}{entry['name']}/{note}")
                    if depth < 1 and not entry["ignored"]:
                        walk(root / entry["path"], depth + 1)
                else:
                    lines.append(f"{indent}{entry['name']}")

        walk(folder, 0)
        head = f"{ws.relative(root, folder)}/" if folder != root else f"{root.name}/ (project root)"
        more = "\n… more entries not shown" if count >= cap else ""
        return head + "\n" + ("\n".join(lines) if lines else "(empty)") + more


class CodeGlob(_Code):
    def __init__(self, store, settings, state) -> None:
        super().__init__(
            store, settings, state,
            name="code_glob",
            description=(
                "Find files by name pattern, like '**/*.py', 'src/**/*.test.ts' or "
                "'*.md'. Returns paths relative to the project root, most "
                "recently modified first. Dependency and build folders are "
                "skipped."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "A glob pattern."},
                    "path": {"type": "string", "description": "A folder to search in. Default: the project root."},
                },
                "required": ["pattern"],
            },
        )

    async def run(self, session, root, pattern=None, path=None, **extra) -> str:
        start = ws.inside(root, plain_text(path) or ".")
        text = plain_text(pattern or extra.get("glob"))
        matches = ws.glob(root, text, start)
        if not matches:
            return f"No files match {text!r}."
        matches.sort(key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True)
        shown = [ws.relative(root, p) for p in matches[: max(1, int(getattr(self.settings, "code_glob_limit", GLOB_LIMIT)))]]
        more = len(matches) - len(shown)
        return "\n".join(shown) + (f"\n… and {more} more -- narrow the pattern" if more > 0 else "")


class CodeGrep(_Code):
    def __init__(self, store, settings, state) -> None:
        super().__init__(
            store, settings, state,
            name="code_grep",
            description=(
                "Search file contents with a regular expression. output_mode "
                "'files_with_matches' (default) lists the files; 'content' shows "
                "matching lines with line numbers, with `context` lines around "
                "each; 'count' gives matches per file. Narrow with `glob` (e.g. "
                "'*.py') or `path`. Dependency and build folders are skipped."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "A regular expression."},
                    "path": {"type": "string", "description": "A file or folder to search. Default: the project."},
                    "glob": {"type": "string", "description": "Only files matching this, e.g. '*.tsx'."},
                    "output_mode": {"type": "string", "enum": ["files_with_matches", "content", "count"]},
                    "case_insensitive": {"type": "boolean"},
                    "context": {"type": "integer", "description": "Lines of context around each match (content mode)."},
                },
                "required": ["pattern"],
            },
        )

    async def run(self, session, root, pattern=None, path=None, glob=None,
                  output_mode="files_with_matches", case_insensitive=False, context=0,
                  **extra) -> str:
        text = plain_text(pattern or extra.get("regex") or extra.get("query"))
        if not text:
            return "Give a pattern to search for."
        where = ws.inside(root, plain_text(path) or ".")
        mode = plain_text(output_mode) or "files_with_matches"
        if mode not in ("files_with_matches", "content", "count"):
            mode = "files_with_matches"
        insensitive = str(case_insensitive).lower() in ("true", "1", "yes")
        around = max(0, min(10, _as_int(context or extra.get("-C"), 0)))
        only = plain_text(glob) or None
        try:
            flags = re.IGNORECASE if insensitive else 0
            compiled = re.compile(text, flags)
        except re.error as exc:
            return f"{text!r} is not a valid regular expression: {exc}."

        if shutil.which("rg"):
            found = await self._ripgrep(root, where, text, mode, insensitive, around, only)
            if found is not None:
                return _clip(found, self.limit) if found.strip() else f"No matches for {text!r}."
        return _clip(self._python(root, where, compiled, mode, around, only), self.limit) or f"No matches for {text!r}."

    async def _ripgrep(self, root, where, text, mode, insensitive, around, only) -> str | None:
        args = ["rg", "--color=never", "--no-heading", "--hidden", "-g", "!.git"]
        for name in sorted(ws.IGNORED):
            args += ["-g", f"!{name}"]
        if only:
            args += ["-g", only]
        if insensitive:
            args.append("-i")
        if mode == "files_with_matches":
            args.append("-l")
        elif mode == "count":
            args.append("-c")
        else:
            args += ["-n"] + (["-C", str(around)] if around else [])
        args += ["-e", text, "--", ws.relative(root, where)]
        try:
            proc = await asyncio.create_subprocess_exec(
                *args, cwd=root, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=30)
        except (OSError, asyncio.TimeoutError):
            return None
        # 1 is "no matches", which is an answer; 2 is an error, where the
        # Python search below is the better answer.
        if proc.returncode not in (0, 1):
            return None
        return out.decode("utf-8", "replace").strip()

    def _python(self, root, where, compiled, mode, around, only) -> str:
        files = [where] if where.is_file() else ws.walk_files(root, where)
        out: list[str] = []
        for path in files:
            rel = ws.relative(root, path)
            if only and not (Path(rel).match(only) or path.name == only):
                continue
            try:
                if path.stat().st_size > ws.MAX_EDITOR_BYTES:
                    continue
                data = path.read_bytes()
            except OSError:
                continue
            if ws.is_binary(data):
                continue
            lines = data.decode("utf-8", "replace").splitlines()
            hits = [i for i, line in enumerate(lines) if compiled.search(line)]
            if not hits:
                continue
            if mode == "files_with_matches":
                out.append(rel)
            elif mode == "count":
                out.append(f"{rel}:{len(hits)}")
            else:
                shown: set[int] = set()
                for i in hits:
                    shown.update(range(max(0, i - around), min(len(lines), i + around + 1)))
                for i in sorted(shown):
                    mark = ":" if i in hits else "-"
                    out.append(f"{rel}{mark}{i + 1}{mark}{lines[i]}")
            if len(out) > 5000:
                break
        return "\n".join(out)


# -- reading and changing -------------------------------------------------------


class CodeRead(_Code):
    def __init__(self, store, settings, state) -> None:
        super().__init__(
            store, settings, state,
            name="code_read",
            description=(
                "Read a file in the project, with line numbers. Long files come "
                f"back {READ_LINES} lines at a time -- pass `offset` (the first "
                "line to read) and `limit` for the rest. Read a file before "
                "editing or rewriting it."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "The file, relative to the project root."},
                    "offset": {"type": "integer", "description": "First line to read, from 1."},
                    "limit": {"type": "integer", "description": "How many lines."},
                },
                "required": ["path"],
            },
        )

    async def run(self, session, root, path=None, offset=1, limit=None, **extra) -> str:
        given = plain_text(path or extra.get("file_path") or extra.get("file"))
        if not given:
            return "Give the file to read."
        target = ws.inside(root, given)
        if target.is_dir():
            return f"{given} is a folder -- use code_ls to see what is in it."
        text = ws.read_text(target, max_bytes=20_000_000)
        self.state.saw(session, target)
        rel = ws.relative(root, target)
        lines = text.split("\n")
        if text.endswith("\n"):
            lines = lines[:-1]
        if not lines or text == "":
            return f"{rel} is empty."
        # A range the way some models were trained to ask for one --
        # gpt-oss writes line_start and line_end -- read as the same thing
        # rather than silently ignored.
        first = extra.get("line_start", extra.get("start_line"))
        last = extra.get("line_end", extra.get("end_line"))
        if first is not None and _as_int(offset, 1) <= 1:
            offset = first
        if last is not None and limit is None:
            limit = _as_int(last, 0) - max(1, _as_int(offset, 1)) + 1
        start = max(1, _as_int(offset, 1))
        count = max(1, min(READ_LINES, _as_int(limit, READ_LINES)))
        window = lines[start - 1 : start - 1 + count]
        body, used, kept = [], 0, 0
        for line in window:
            used += min(len(line), MAX_LINE) + 8
            if used > self.limit and kept:
                break
            body.append(line)
            kept += 1
        end = start + kept - 1
        said = f"{rel} (lines {start}-{end} of {len(lines)}):\n" + _numbered(body, start)
        if end < len(lines):
            said += f"\n… {len(lines) - end} more lines -- read on with offset={end + 1}."
        return said


class CodeWrite(_Code):
    surfaces = "workspace"

    def __init__(self, store, settings, state) -> None:
        super().__init__(
            store, settings, state,
            name="code_write",
            description=(
                "Create a file, or replace one whole, with `content`. For a change "
                "to part of an existing file use code_edit instead. Replacing an "
                "existing file needs a code_read of it first. Parent folders are "
                "created as needed."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "The file, relative to the project root."},
                    "content": {"type": "string", "description": "The whole file."},
                },
                "required": ["path", "content"],
            },
        )

    @property
    def must_ask(self) -> bool:
        return True

    async def run(self, session, root, path=None, content=None, **extra) -> str:
        given = plain_text(path or extra.get("file_path") or extra.get("file"))
        if not given:
            return "Give the file to write."
        if content is None:
            content = extra.get("text") or extra.get("contents")
        if content is None:
            return "Give the file's `content`."
        if not isinstance(content, str):
            content = plain_text(content)
        target = ws.inside(root, given)
        rel = ws.relative(root, target)
        if ws.in_git_dir(root, target):
            return "Files inside .git are not written directly -- use git through code_bash."
        existed = target.exists()
        if existed and not self.state.fresh(session, target):
            return (
                f"Read {rel} with code_read first: code_write replaces the whole file, "
                "and it has not been read in this conversation (or changed since)."
            )
        ws.write_text(target, content)
        self.state.saw(session, target)
        lines = content.count("\n") + (0 if content.endswith("\n") or not content else 1)
        verb = "Replaced" if existed else "Created"
        return Touched(f"{verb} {rel} ({lines} line{'' if lines == 1 else 's'}).", [rel])


class CodeEdit(_Code):
    surfaces = "workspace"

    def __init__(self, store, settings, state) -> None:
        super().__init__(
            store, settings, state,
            name="code_edit",
            description=(
                "Change part of a file by exact replacement. old_string must match "
                "the file exactly -- whitespace and indentation included, without "
                "the line-number prefix code_read shows -- and occur once, unless "
                "replace_all is set. For several changes to one file, pass "
                "`edits` as a list of {old_string, new_string, replace_all}; they "
                "apply in order, and if any does not match, none are made. Needs "
                "a code_read of the file first."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "The file, relative to the project root."},
                    "old_string": {"type": "string", "description": "Exact text to replace."},
                    "new_string": {"type": "string", "description": "What it becomes."},
                    "replace_all": {"type": "boolean", "description": "Replace every occurrence."},
                    "edits": {
                        "type": "array",
                        "description": "Several edits to this file, applied in order.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "old_string": {"type": "string"},
                                "new_string": {"type": "string"},
                                "replace_all": {"type": "boolean"},
                            },
                            "required": ["old_string", "new_string"],
                        },
                    },
                },
                "required": ["path"],
            },
        )

    @property
    def must_ask(self) -> bool:
        return True

    async def run(self, session, root, path=None, old_string=None, new_string=None,
                  replace_all=False, edits=None, **extra) -> str:
        given = plain_text(path or extra.get("file_path") or extra.get("file"))
        if not given:
            return "Give the file to edit."
        target = ws.inside(root, given)
        rel = ws.relative(root, target)
        if ws.in_git_dir(root, target):
            return "Files inside .git are not edited directly -- use git through code_bash."
        if not target.exists():
            return f"{rel} does not exist -- create it with code_write."
        if not self.state.fresh(session, target):
            return (
                f"Read {rel} with code_read first -- it has not been read in this "
                "conversation, or it changed since (perhaps edited in the editor)."
            )

        changes = []
        listed = edits if isinstance(edits, list) else ([] if edits is None else [edits])
        for item in listed:
            item = item if isinstance(item, dict) else as_dict(item)
            if isinstance(item, dict):
                changes.append((
                    item.get("old_string", item.get("old", item.get("find"))),
                    item.get("new_string", item.get("new", item.get("replace"))),
                    str(item.get("replace_all", False)).lower() in ("true", "1"),
                ))
        if old_string is not None or new_string is not None:
            changes.insert(0, (old_string, new_string, str(replace_all).lower() in ("true", "1")))
        if not changes:
            return "Give old_string and new_string, or a list of `edits`."

        text = ws.read_text(target, max_bytes=20_000_000)
        problems: list[str] = []
        first_at: int | None = None
        for number, (old, new, every) in enumerate(changes, start=1):
            old = "" if old is None else (old if isinstance(old, str) else plain_text(old))
            new = "" if new is None else (new if isinstance(new, str) else plain_text(new))
            label = f"edit {number}" if len(changes) > 1 else "the edit"
            if not old:
                problems.append(f"{label}: old_string is empty -- use code_write to create a file")
                continue
            if old == new:
                problems.append(f"{label}: old_string and new_string are the same")
                continue
            count = text.count(old)
            if count == 0:
                near = closest(text, old)
                hint = f" The closest text in the file is:\n{near}" if near else ""
                problems.append(f"{label}: old_string was not found in {rel}.{hint}")
                continue
            if count > 1 and not every:
                problems.append(
                    f"{label}: old_string occurs {count} times in {rel} -- include more "
                    "surrounding lines to make it unique, or set replace_all"
                )
                continue
            at = text.find(old)
            text = text.replace(old, new) if every else text.replace(old, new, 1)
            if first_at is None:
                first_at = at
        if problems:
            return "Nothing was changed. " + " ".join(p if p.endswith(("\n", ".")) else p + "." for p in problems)

        ws.write_text(target, text)
        self.state.saw(session, target)
        # The edited region with line numbers, the way it now reads -- enough
        # for the model to see the change landed as meant.
        lines = text.split("\n")
        line_no = text[: first_at or 0].count("\n")
        start = max(0, line_no - 4)
        snippet = _numbered(lines[start : start + 12], start + 1)
        count = len(changes)
        return Touched(
            f"Edited {rel} ({count} change{'' if count == 1 else 's'}). Around the change:\n{snippet}",
            [rel],
        )


# -- running --------------------------------------------------------------------


class CodeBash(_Code):
    surfaces = "workspace"

    def __init__(self, store, settings, state) -> None:
        super().__init__(
            store, settings, state,
            name="code_bash",
            description=(
                "Run a shell command in the project folder and see its output: "
                "tests, builds, linters, package scripts, git. Each command starts "
                "in the project root and runs non-interactively -- no prompts, no "
                "editors, no pagers. `timeout` is in seconds; the default and "
                "the longest allowed are given with the project. Prefer code_grep, "
                "code_glob and code_read over grep, find and cat. Never run a "
                "destructive or outward-facing command the user did not ask for, "
                "and never install packages or tools (pip, npm, brew…) without "
                "asking first -- say what is missing instead."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "The command to run."},
                    "description": {"type": "string", "description": "What it does, in a few words."},
                    "timeout": {"type": "integer", "description": "Seconds before it is stopped."},
                },
                "required": ["command"],
            },
        )

    @property
    def must_ask(self) -> bool:
        return True

    async def run(self, session, root, command=None, timeout=None, **extra) -> str:
        text = plain_text(command or extra.get("cmd") or extra.get("script"))
        if not text:
            return "Give the command to run."
        limit = max(1, min(
            _as_int(timeout, self.settings.code_timeout),
            int(getattr(self.settings, "code_timeout_max", 600)),
        ))
        shell = command_shell()
        env = {k: v for k, v in os.environ.items() if k not in SECRET_ENV}
        env.update({"PAGER": "cat", "GIT_PAGER": "cat", "GIT_TERMINAL_PROMPT": "0",
                    "TERM": "dumb", "NO_COLOR": "1"})
        try:
            proc = await asyncio.create_subprocess_exec(
                shell, "-c", text,
                cwd=root, env=env,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                # Its own process group, so a timeout stops everything it
                # started -- a test runner's workers, a dev server -- and not
                # just the shell in front of them.
                start_new_session=True,
            )
        except OSError as exc:
            return f"The command could not be started: {exc}."
        timed_out = False
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=limit)
        except asyncio.TimeoutError:
            timed_out = True
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            out, _ = await proc.communicate()
        except asyncio.CancelledError:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            raise
        output = _clip(out.decode("utf-8", "replace").rstrip(), self.limit)
        status = (
            f"[stopped after {limit}s -- it did not finish]" if timed_out
            else f"[exit code {proc.returncode}]"
        )
        said = f"$ {text}\n{output}\n{status}" if output else f"$ {text}\n(no output)\n{status}"
        # A command can change anything, so the editor is told to look again.
        return Touched(said, ["*"])


class CodeTodo(_Code):
    def __init__(self, store, settings, state) -> None:
        super().__init__(
            store, settings, state,
            name="code_todo",
            description=(
                "Write the task list for this piece of work: the whole list each "
                "time, each item {content, status: pending | in_progress | "
                "completed}. Use it for work with more than two or three steps; "
                "keep exactly one item in_progress and mark items completed as "
                "soon as they are. The user sees the list."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "todos": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "content": {"type": "string"},
                                "status": {"type": "string", "enum": list(TODO_STATES)},
                            },
                            "required": ["content", "status"],
                        },
                    },
                },
                "required": ["todos"],
            },
        )

    async def use(self, session: str, todos=None, **extra) -> str:
        listed = todos if isinstance(todos, list) else (as_dict(todos) or {}).get("todos") or []
        clean = []
        for item in listed:
            item = item if isinstance(item, dict) else as_dict(item)
            if not isinstance(item, dict):
                continue
            content = plain_text(item.get("content") or item.get("task") or item.get("title"))
            status = plain_text(item.get("status")).lower().replace(" ", "_")
            if status not in TODO_STATES:
                status = "pending"
            if content:
                clean.append({"content": content[:300], "status": status})
        if not clean:
            return "Give the list as `todos`, each {content, status}."
        self.state.todos[session] = clean
        done = sum(1 for t in clean if t["status"] == "completed")
        doing = [t["content"] for t in clean if t["status"] == "in_progress"]
        said = f"Task list updated: {done} of {len(clean)} done."
        if doing:
            said += f" In progress: {doing[0]}."
        if len(doing) > 1:
            said += " Keep only one item in_progress at a time."
        return said


def code_skills(store: Store, settings, state: CodeState | None = None) -> list[Skill]:
    """Every code tool, sharing one record of what has been read."""
    state = state or CodeState()
    return [
        cls(store, settings, state)
        for cls in (CodeLs, CodeGlob, CodeGrep, CodeRead, CodeEdit, CodeWrite, CodeBash, CodeTodo)
    ]
