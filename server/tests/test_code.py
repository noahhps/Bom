"""Code conversations: the project folder, the code tools, and the editor API."""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import workspace as ws
from app.approvals import write_auto_approved
from app.code_mode import CODE_PREAMBLE
from app.config import Settings
from app.db import Database
from app.main import create_app
from app.orchestrator import Orchestrator
from app.providers.base import Chunk, ToolCall
from app.providers.router import ProviderRouter
from app.skills.canvas import WriteCanvas
from app.skills.code import CodeState, code_skills
from app.skills.registry import Registry
from app.store import Store


@pytest.fixture
def base(tmp_path: Path) -> Path:
    """Where projects may be opened from, standing in for the home folder."""
    folder = tmp_path / "home"
    folder.mkdir()
    return folder.resolve()


@pytest.fixture
def project(base: Path) -> Path:
    root = base / "shop"
    (root / "src").mkdir(parents=True)
    (root / "node_modules" / "left-pad").mkdir(parents=True)
    (root / "src" / "cart.py").write_text(
        "def total(items):\n"
        "    return sum(item.price for item in items)\n"
        "\n"
        "\n"
        "def count(items):\n"
        "    return len(items)\n"
    )
    (root / "src" / "cart_test.py").write_text("from cart import total\n\nassert total([]) == 0\n")
    (root / "README.md").write_text("# Shop\n")
    (root / "node_modules" / "left-pad" / "index.js").write_text("module.exports = total;\n")
    (root / ".git").mkdir()
    (root / ".git" / "HEAD").write_text("ref: refs/heads/feature/cart\n")
    return root


@pytest.fixture
def store(tmp_path: Path) -> Store:
    return Store(Database(tmp_path / "code.db"))


def _settings(base: Path, **extra):
    return SimpleNamespace(
        workspace_roots=(base,), code_timeout=20, code_timeout_max=30,
        code_output_chars=30_000, **extra,
    )


def _tools(store, base):
    return {skill.name: skill for skill in code_skills(store, _settings(base), CodeState())}


def _session(store: Store, project: Path) -> str:
    return store.create_session(mode="code", workspace=str(project))["id"]


# -- the folder -------------------------------------------------------------------


def test_a_project_folder_is_accepted_and_broad_ones_are_not(base: Path, project: Path, tmp_path: Path):
    assert ws.validate_root(str(project), (base,)) == project
    for broad in ("/", str(Path.home()), str(base), "/Users", "/etc"):
        with pytest.raises(ws.WorkspaceError):
            ws.validate_root(broad, (base,))
    keys = base / ".ssh" / "project"
    keys.mkdir(parents=True)
    with pytest.raises(ws.WorkspaceError, match="keys"):
        ws.validate_root(str(keys), (base,))
    outside = tmp_path / "elsewhere" / "proj"
    outside.mkdir(parents=True)
    with pytest.raises(ws.WorkspaceError, match="outside"):
        ws.validate_root(str(outside), (base,))
    with pytest.raises(ws.WorkspaceError):
        ws.validate_root(str(project / "README.md"), (base,))
    with pytest.raises(ws.WorkspaceError):
        ws.validate_root("relative/path", (base,))


def test_paths_cannot_leave_the_project(project: Path, base: Path):
    assert ws.inside(project, "src/cart.py") == project / "src" / "cart.py"
    for escape in ("../secret.txt", "/etc/passwd", "~/x", "src/../../x"):
        with pytest.raises(ws.WorkspaceError):
            ws.inside(project, escape)
    (base / "secret.txt").write_text("key")
    os.symlink(base / "secret.txt", project / "link.txt")
    with pytest.raises(ws.WorkspaceError, match="outside"):
        ws.inside(project, "link.txt")


def test_a_save_from_an_older_version_is_refused(project: Path):
    target = project / "README.md"
    opened = ws.mtime(target)
    os.utime(target, (opened + 5, opened + 5))
    with pytest.raises(ws.Conflict):
        ws.write_text(target, "# Mine\n", expected=opened)
    assert target.read_text() == "# Shop\n"
    saved = ws.write_text(target, "# Mine\n", expected=ws.mtime(target))
    assert target.read_text() == "# Mine\n" and saved == ws.mtime(target)
    assert not [p for p in project.iterdir() if p.name.endswith(".tmp")], "no temp file left behind"


def test_the_summary_names_the_branch_and_skips_dependencies(project: Path):
    (project / "CLAUDE.md").write_text("Run tests with pytest.")
    said = ws.summary(project)
    assert "feature/cart" in said and "src/" in said and "README.md" in said
    assert "node_modules" not in said
    assert "Run tests with pytest." in said


# -- the tools --------------------------------------------------------------------


@pytest.mark.asyncio
async def test_read_numbers_lines_and_pages(store, base, project):
    tools = _tools(store, base)
    sid = _session(store, project)
    said = await tools["code_read"].use(session=sid, path="src/cart.py")
    assert "src/cart.py (lines 1-6 of 6)" in said
    assert "     2\t    return sum(item.price for item in items)" in said
    paged = await tools["code_read"].use(session=sid, path="src/cart.py", offset=5, limit=1)
    assert "     5\tdef count(items):" in paged and "read on with offset=6" in paged
    assert "outside the project" in await tools["code_read"].use(session=sid, path="../x")
    # The range as gpt-oss was trained to ask for it.
    ranged = await tools["code_read"].use(session=sid, path="src/cart.py", line_start=2, line_end=3)
    assert "(lines 2-3 of 6)" in ranged and "     1\t" not in ranged


@pytest.mark.asyncio
async def test_edit_needs_a_fresh_read_and_is_exact(store, base, project):
    tools = _tools(store, base)
    sid = _session(store, project)
    edit = tools["code_edit"]
    said = await edit.use(session=sid, path="src/cart.py", old_string="len(items)", new_string="len(list(items))")
    assert "Read src/cart.py with code_read first" in said

    await tools["code_read"].use(session=sid, path="src/cart.py")
    said = await edit.use(session=sid, path="src/cart.py", old_string="len(items)", new_string="len(list(items))")
    assert said.startswith("Edited src/cart.py (1 change)") and said.paths == ("src/cart.py",)
    assert "len(list(items))" in (project / "src" / "cart.py").read_text()
    assert "     6\t    return len(list(items))" in said, "the edited region comes back numbered"

    # The reader changes the file in the editor: the model's copy is stale.
    target = project / "src" / "cart.py"
    target.write_text(target.read_text() + "\n# note\n")
    os.utime(target, (ws.mtime(target) + 3,) * 2)
    said = await edit.use(session=sid, path="src/cart.py", old_string="# note", new_string="# n")
    assert "changed since" in said


@pytest.mark.asyncio
async def test_a_miss_changes_nothing_and_quotes_the_closest_text(store, base, project):
    tools = _tools(store, base)
    sid = _session(store, project)
    await tools["code_read"].use(session=sid, path="src/cart.py")
    before = (project / "src" / "cart.py").read_text()
    said = await tools["code_edit"].use(session=sid, path="src/cart.py", edits=[
        {"old_string": "def total(items):", "new_string": "def total(items, tax=0):"},
        {"old_string": "return sum(item.cost for item in items)", "new_string": "x"},
    ])
    assert said.startswith("Nothing was changed.")
    assert "return sum(item.price for item in items)" in said, "the closest line is quoted"
    assert (project / "src" / "cart.py").read_text() == before, "all or nothing"

    said = await tools["code_edit"].use(session=sid, path="src/cart.py", old_string="items", new_string="rows")
    assert "occurs" in said and "replace_all" in said
    said = await tools["code_edit"].use(session=sid, path="src/cart.py", old_string="items", new_string="rows", replace_all=True)
    assert "items" not in (project / "src" / "cart.py").read_text()


@pytest.mark.asyncio
async def test_write_creates_and_only_replaces_what_was_read(store, base, project):
    tools = _tools(store, base)
    sid = _session(store, project)
    write = tools["code_write"]
    said = await write.use(session=sid, path="src/tax.py", content="RATE = 0.2\n")
    assert said.startswith("Created src/tax.py (1 line)") and said.paths == ("src/tax.py",)
    assert "Read README.md with code_read first" in await write.use(session=sid, path="README.md", content="x")
    await tools["code_read"].use(session=sid, path="README.md")
    assert (await write.use(session=sid, path="README.md", content="# Shop 2\n")).startswith("Replaced")
    assert "not written directly" in await write.use(session=sid, path=".git/config", content="x")
    # Having just written it, the model may write it again without a re-read.
    assert (await write.use(session=sid, path="src/tax.py", content="RATE = 0.25\n")).startswith("Replaced")


@pytest.mark.asyncio
async def test_glob_grep_and_ls_skip_dependencies(store, base, project):
    tools = _tools(store, base)
    sid = _session(store, project)
    globbed = await tools["code_glob"].use(session=sid, pattern="**/*.py")
    assert set(globbed.splitlines()) == {"src/cart.py", "src/cart_test.py"}
    found = await tools["code_grep"].use(session=sid, pattern="total")
    assert "src/cart.py" in found and "node_modules" not in found
    content = await tools["code_grep"].use(session=sid, pattern=r"def \w+", output_mode="content", glob="*.py")
    assert "src/cart.py:1:def total(items):" in content
    listed = await tools["code_ls"].use(session=sid)
    assert "src/" in listed and "  cart.py" in listed and "node_modules/ (ignored)" in listed
    assert ".git" not in listed


@pytest.mark.asyncio
async def test_grep_without_ripgrep_finds_the_same(store, base, project, monkeypatch):
    monkeypatch.setattr(shutil, "which", lambda name: None)
    tools = _tools(store, base)
    sid = _session(store, project)
    found = await tools["code_grep"].use(session=sid, pattern="total", output_mode="count")
    assert set(found.splitlines()) == {"src/cart.py:1", "src/cart_test.py:2"}


@pytest.mark.asyncio
async def test_bash_runs_in_the_project_and_is_stopped_on_time(store, base, project):
    tools = _tools(store, base)
    sid = _session(store, project)
    bash = tools["code_bash"]
    assert bash.must_ask and tools["code_edit"].must_ask and tools["code_write"].must_ask
    said = await bash.use(session=sid, command="pwd && ls src && echo $AUTH_TOKEN-gone && exit 3")
    assert str(project) in said and "cart.py" in said and "[exit code 3]" in said
    assert said.paths == ("*",)
    assert "-gone" in said and "test-token" not in said
    slow = await bash.use(session=sid, command="sleep 5; echo never", timeout=1)
    assert "stopped after 1s" in slow and "(no output)" in slow


@pytest.mark.asyncio
async def test_todo_keeps_the_list(store, base, project):
    tools = _tools(store, base)
    sid = _session(store, project)
    said = await tools["code_todo"].use(session=sid, todos=[
        {"content": "Add tax", "status": "completed"},
        {"content": "Write tests", "status": "in_progress"},
        {"content": "Run them", "status": "pending"},
    ])
    assert said == "Task list updated: 1 of 3 done. In progress: Write tests."
    assert tools["code_todo"].state.todos[sid][1]["status"] == "in_progress"


@pytest.mark.asyncio
async def test_without_a_folder_the_tools_say_so(store, base):
    tools = _tools(store, base)
    sid = store.create_session(mode="code")["id"]
    assert "No project folder is open" in await tools["code_ls"].use(session=sid)


# -- the turn ---------------------------------------------------------------------


class _Coder:
    name = "mock"
    model = "mock"

    def __init__(self, rounds):
        self.rounds = list(rounds)
        self.tools: list[set] = []
        self.systems: list[str] = []

    async def stream(self, messages, *, think=None, tools=None):
        self.tools.append({t["name"] for t in tools or []})
        self.systems.append(messages[0].content)
        if self.rounds:
            name, args = self.rounds.pop(0)
            yield Chunk(done=True, tool_calls=(ToolCall(f"c{len(self.rounds)}", name, args),))
        else:
            yield Chunk(text="Done.", done=True)

    async def embed(self, texts):
        return [[0.0] * 8 for _ in texts]

    async def health(self):
        return True


def _orchestrator(store, base, provider, extra=()):
    registry = Registry()
    for skill in (*code_skills(store, _settings(base), CodeState()), WriteCanvas(store), *extra):
        registry.register(skill)
    router = ProviderRouter.__new__(ProviderRouter)

    async def resolve(prefer=None):
        return type("Route", (), {"provider": provider, "reason": "local"})()

    router.resolve = resolve
    router.invalidate_health = lambda: None
    settings = type("S", (), {
        "system_preamble": "You help.", "context_tokens": 16384, "reply_tokens": 1024,
        "ollama_think": "medium", "memory_max_facts": 20, "memory_fact_chars": 200,
        "workspace_roots": (base,),
    })()
    return Orchestrator(settings, store, router, registry)


@pytest.mark.asyncio
async def test_a_code_turn_is_offered_code_tools_and_told_about_the_project(store, base, project):
    write_auto_approved(store, {"code_edit"})
    provider = _Coder([
        ("code_read", {"path": "src/cart.py"}),
        ("code_edit", {"path": "src/cart.py", "old_string": "len(items)", "new_string": "len(tuple(items))"}),
        ("write_canvas", {"title": "x", "content": "y"}),
    ])
    orch = _orchestrator(store, base, provider)
    sid = _session(store, project)
    joined = "".join([f async for f in orch.run_turn(sid, "Make count accept generators")])

    assert "code_edit" in provider.tools[0] and "write_canvas" not in provider.tools[0]
    assert CODE_PREAMBLE in provider.systems[0] and "feature/cart" in provider.systems[0]
    # The machine the commands run on, and the shell that runs them.
    assert "Commands run with" in provider.systems[0] and "System: " in provider.systems[0]
    events = [json.loads(b.split("data: ", 1)[1]) for b in joined.split("\n\n")
              if b.startswith("event: workspace\n")]
    assert events == [{"paths": ["src/cart.py"]}]
    assert "len(tuple(items))" in (project / "src" / "cart.py").read_text()
    assert "not available in this kind of conversation" in joined, "a canvas tool is refused here"


@pytest.mark.asyncio
async def test_a_chat_is_not_offered_the_code_tools(store, base):
    provider = _Coder([])
    orch = _orchestrator(store, base, provider)
    sid = store.create_session()["id"]
    [f async for f in orch.run_turn(sid, "hello")]
    assert "write_canvas" in provider.tools[0]
    assert not any(name.startswith("code_") for name in provider.tools[0])


class _Quiet:
    """A model that ends its first `silent` rounds with nothing at all."""

    name = "mock"
    model = "mock"

    def __init__(self, silent):
        self.silent = silent
        self.windows: list[list] = []

    async def stream(self, messages, *, think=None, tools=None):
        self.windows.append(list(messages))
        if self.silent:
            self.silent -= 1
            yield Chunk(done=True)
        else:
            yield Chunk(text="It is a shop.", done=True)

    async def embed(self, texts):
        return [[0.0] * 8 for _ in texts]

    async def health(self):
        return True


@pytest.mark.asyncio
async def test_a_turn_that_says_nothing_is_asked_once_to_answer(store, base, project):
    provider = _Quiet(silent=1)
    orch = _orchestrator(store, base, provider)
    joined = "".join([f async for f in orch.run_turn(_session(store, project), "what is this?")])
    assert "It is a shop." in joined and "event: error" not in joined
    asked = provider.windows[1][-1]
    assert asked.role == "user" and "your last reply was empty" in asked.content


@pytest.mark.asyncio
async def test_a_turn_that_stays_silent_says_so_after_one_nudge(store, base, project):
    provider = _Quiet(silent=5)
    orch = _orchestrator(store, base, provider)
    joined = "".join([f async for f in orch.run_turn(_session(store, project), "what is this?")])
    assert len(provider.windows) == 2, "asked once more, not until the rounds run out"
    assert "event: error" in joined and "even when asked a second time" in joined


@pytest.mark.asyncio
async def test_a_code_turn_is_not_offered_the_calendar(store, base, project):
    from app.skills.calendar import AddEvent, ListEvents

    provider = _Coder([])
    orch = _orchestrator(store, base, provider, extra=(AddEvent(store), ListEvents(store)))
    [f async for f in orch.run_turn(_session(store, project), "hello")]
    assert not {"add_event", "list_events"} & provider.tools[0]
    chat = _Coder([])
    orch = _orchestrator(store, base, chat, extra=(AddEvent(store), ListEvents(store)))
    [f async for f in orch.run_turn(store.create_session()["id"], "hello")]
    assert {"add_event", "list_events"} <= chat.tools[0]


@pytest.mark.asyncio
async def test_a_made_up_tool_is_told_only_what_this_conversation_has(store, base, project):
    provider = _Coder([("search", {"query": "cart"})])
    orch = _orchestrator(store, base, provider)
    joined = "".join([f async for f in orch.run_turn(_session(store, project), "find the cart")])
    said = next(json.loads(b.split("data: ", 1)[1])["text"] for b in joined.split("\n\n")
                if b.startswith("event: tool_result\n"))
    assert said.startswith("There is no skill called 'search'.")
    assert "code_grep" in said and "write_canvas" not in said


def test_file_and_google_mcp_servers_stay_out_of_code():
    from app.skills.mcp_skill import offered_in_code

    npx = "npx"
    assert not offered_in_code("filesystem", npx, ["-y", "@modelcontextprotocol/server-filesystem", "/x"])
    assert not offered_in_code("my files", npx, ["-y", "@modelcontextprotocol/server-filesystem", "/x"])
    assert not offered_in_code("google_workspace", npx, ["-y", "@presto-ai/google-workspace-mcp"])
    assert not offered_in_code("cal", npx, ["-y", "@iflow-mcp/mcp-google-workspace"])
    assert offered_in_code("github", npx, ["-y", "@modelcontextprotocol/server-github"])
    assert offered_in_code("context7", npx, ["-y", "@upstash/context7-mcp"])
    assert offered_in_code("exa", None, None)


@pytest.mark.asyncio
async def test_a_command_waits_for_approval(store, base, project):
    provider = _Coder([("code_bash", {"command": "echo hi"})])
    orch = _orchestrator(store, base, provider)
    sid = _session(store, project)
    frames = orch.run_turn(sid, "say hi")
    seen = ""
    async for frame in frames:
        seen += frame
        if "event: skill_approval" in frame:
            request = json.loads(frame.split("data: ", 1)[1])
            assert request["name"] == "code_bash" and request["arguments"]["command"] == "echo hi"
            orch.approvals.resolve(request["id"], "allow_once")
    assert "[exit code 0]" in seen


# -- the editor API ---------------------------------------------------------------


@pytest.fixture
def client(tmp_path: Path, base: Path) -> TestClient:
    settings = Settings(db_path=tmp_path / "api.db", auth_token="t", workspace_roots=(base,))
    return TestClient(create_app(settings), headers={"Authorization": "Bearer t"})


def test_the_editor_reads_saves_and_is_told_about_conflicts(client, project):
    root = str(project)
    opened = client.post("/api/workspace/open", json={"path": root}).json()
    assert opened == {"root": root, "name": "shop", "branch": "feature/cart"}
    # Opening a folder makes it a code project, before any conversation.
    assert client.get("/api/workspace/recent").json()["folders"][0]["root"] == root

    tree = client.get("/api/workspace/tree", params={"root": root}).json()["entries"]
    assert [e["name"] for e in tree][:2] == ["node_modules", "src"]
    assert next(e for e in tree if e["name"] == "node_modules")["ignored"] is True
    assert ".git" not in [e["name"] for e in tree]

    files = client.get("/api/workspace/files", params={"root": root}).json()["files"]
    assert "src/cart.py" in files and not any(f.startswith("node_modules") for f in files)

    got = client.get("/api/workspace/file", params={"root": root, "path": "src/cart.py"}).json()
    assert got["content"].startswith("def total")
    saved = client.put("/api/workspace/file", json={
        "root": root, "path": "src/cart.py", "content": "# new\n", "mtime": got["mtime"]})
    assert saved.status_code == 200
    stale = client.put("/api/workspace/file", json={
        "root": root, "path": "src/cart.py", "content": "# old\n", "mtime": got["mtime"] - 100})
    assert stale.status_code == 409 and "mtime" in stale.json()["detail"]
    assert (project / "src" / "cart.py").read_text() == "# new\n"

    made = client.post("/api/workspace/entry", json={"root": root, "path": "src/new/thing.py"})
    assert made.status_code == 200 and (project / "src" / "new" / "thing.py").exists()

    (project / "logo.bin").write_bytes(b"\x89PNG\0\0\0")
    assert client.get("/api/workspace/file", params={"root": root, "path": "logo.bin"}).status_code == 415
    assert client.get("/api/workspace/file", params={"root": root, "path": "../x"}).status_code == 400


def test_the_picker_browses_only_where_projects_may_be(client, base, project):
    listed = client.get("/api/workspace/browse").json()
    assert listed["path"] == str(base) and listed["parent"] is None
    assert {"name": "shop", "path": str(project), "project": True} in listed["dirs"]
    assert listed["openable"] is False, "the base itself is too broad"
    inside = client.get("/api/workspace/browse", params={"path": str(project)}).json()
    assert inside["openable"] is True and inside["parent"] == str(base)
    assert client.get("/api/workspace/browse", params={"path": "/"}).status_code == 400
    assert client.post("/api/workspace/open", json={"path": str(base)}).status_code == 400


def test_a_code_conversation_keeps_its_folder(client, project):
    made = client.post("/api/sessions", json={"mode": "code", "workspace": str(project)}).json()
    assert made["mode"] == "code" and made["workspace"] == str(project)
    listed = client.get("/api/sessions").json()["sessions"]
    assert listed[0]["workspace"] == str(project)
    recent = client.get("/api/workspace/recent").json()["folders"]
    assert recent[0]["name"] == "shop"
    moved = client.put(f"/api/sessions/{made['id']}/workspace", json={"workspace": "/"})
    assert moved.status_code == 400
