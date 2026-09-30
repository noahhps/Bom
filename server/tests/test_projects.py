"""Projects of three kinds, and designs carried from design projects into code."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import db as db_module
from app import design_export
from app.config import Settings
from app.db import Database
from app.main import create_app
from app.orchestrator import Orchestrator
from app.providers.base import Chunk, ToolCall
from app.providers.router import ProviderRouter
from app.skills.code import CodeState, code_skills
from app.skills.projects import project_skills
from app.skills.registry import Registry
from app.skills.wireframe import normalize_wireframe
from app.store import Store

PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 24


@pytest.fixture
def base(tmp_path: Path) -> Path:
    folder = tmp_path / "home"
    folder.mkdir()
    return folder.resolve()


@pytest.fixture
def store(tmp_path: Path) -> Store:
    return Store(Database(tmp_path / "projects.db"))


def _settings(base: Path, **extra):
    values = dict(
        workspace_roots=(base,), projects_dir=base / "BomProjects", canvas_read_chars=40_000,
        code_timeout=20, code_timeout_max=30, code_output_chars=30_000,
    )
    values.update(extra)
    return SimpleNamespace(**values)


def _tools(store, base, **extra):
    return {s.name: s for s in project_skills(store, _settings(base, **extra))}


@pytest.fixture
def designs(store: Store) -> dict:
    """A design project with a wireframe and a page in one of its
    conversations, and a sheet in a design conversation filed nowhere."""
    harbour = store.create_project("Harbour Coffee", kind="design")
    sid = store.create_session(title="Landing ideas", mode="design", design="swiss")["id"]
    store.set_session_project(sid, harbour["id"])
    photo = store.add_image(sid, name="Latte art.png", mime="image/png", width=2, height=2, data=PNG)
    doc = normalize_wireframe([
        {"name": "Home", "layers": [
            {"type": "heading", "text": "Harbour Coffee"},
            {"type": "image", "image": photo.id},
            {"type": "button", "text": "See menu", "link": "Menu"},
        ]},
        {"name": "Menu", "layers": [{"type": "text", "text": "Flat white"}]},
    ])
    wire = store.create_canvas(sid, "Mobile app", content=json.dumps(doc), kind="wireframe")
    page = store.create_canvas(
        sid, "Landing page", kind="html",
        content=f'<!doctype html><h1>Harbour</h1><img src="bom-image:{photo.id}">',
    )
    loose = store.create_session(title="Price list", mode="design")["id"]
    sheet = store.create_canvas(
        loose, "Prices", kind="sheet",
        content=json.dumps({"columns": ["Drink", "Price"], "rows": [["Flat white", 4.2], ["Mocha", "=B2+1"]]}),
    )
    chat = store.create_session(title="Just chatting")["id"]
    store.create_canvas(chat, "Notes", content="not a design")
    return {"project": harbour, "session": sid, "wire": wire, "page": page, "sheet": sheet,
            "loose": loose, "photo": photo}


# -- the store --------------------------------------------------------------------


def test_a_code_conversation_is_filed_under_its_folder(store: Store, base: Path):
    shop, blog = base / "shop", base / "blog"
    shop.mkdir(), blog.mkdir()
    first = store.create_session(mode="code", workspace=str(shop))
    second = store.create_session(mode="code", workspace=str(shop))
    assert first["project_id"] and first["project_id"] == second["project_id"]
    record = store.get_project(first["project_id"])
    assert record["kind"] == "code" and record["path"] == str(shop) and record["name"] == "shop"

    store.set_session_workspace(second["id"], str(blog))
    moved = store.get_session(second["id"])
    assert moved["project_id"] != first["project_id"]
    assert store.get_project(moved["project_id"])["path"] == str(blog)
    kinds = {p["name"]: (p["kind"], p["session_count"]) for p in store.list_projects()}
    assert kinds == {"shop": ("code", 1), "blog": ("code", 1)}


def test_recent_folders_are_the_code_projects_newest_first(store: Store, base: Path):
    old, used, fresh = base / "old", base / "used", base / "fresh"
    for folder in (old, used, fresh):
        folder.mkdir()
    store.ensure_code_project(str(old))
    store.ensure_code_project(str(used))
    store.db.execute("UPDATE projects SET updated_at = 1")
    sid = store.create_session(mode="code", workspace=str(used))["id"]
    store.touch_session(sid)
    store.ensure_code_project(str(fresh))
    recent = store.recent_workspaces()
    assert recent[0] in (str(used), str(fresh)) and recent[-1] == str(old)
    assert set(recent) == {str(old), str(used), str(fresh)}, "a project with no conversation yet is listed"
    store.delete_project(store.code_project_at(str(old))["id"])
    assert str(old) not in store.recent_workspaces(), "a removed project stays removed"


def test_the_migration_makes_a_project_of_every_code_folder(tmp_path: Path, monkeypatch):
    path = tmp_path / "old.db"
    monkeypatch.setattr(db_module, "MIGRATIONS", db_module.MIGRATIONS[:20])
    Database(path).close()
    conn = sqlite3.connect(path)
    conn.executemany(
        "INSERT INTO sessions (id, title, created_at, updated_at, mode, workspace) VALUES (?, ?, 1, 2, ?, ?)",
        [("s1", "a", "code", "/work/shop"), ("s2", "b", "code", "/work/shop"),
         ("s3", "c", "code", "/work/blog"), ("s4", "d", "chat", None)],
    )
    conn.commit()
    conn.close()
    monkeypatch.undo()

    store = Store(Database(path))
    projects = {p["name"]: p for p in store.list_projects()}
    assert set(projects) == {"shop", "blog"}
    assert projects["shop"]["kind"] == "code" and projects["shop"]["path"] == "/work/shop"
    assert projects["shop"]["session_count"] == 2
    assert store.get_session("s4")["project_id"] is None


def test_code_conversations_begun_by_an_older_server_are_filed_later(tmp_path: Path, monkeypatch):
    """A database already at 21, written to by a server that predates it."""
    path = tmp_path / "between.db"
    monkeypatch.setattr(db_module, "MIGRATIONS", db_module.MIGRATIONS[:21])
    Store(Database(path)).ensure_code_project("/work/shop")
    conn = sqlite3.connect(path)
    conn.executemany(
        "INSERT INTO sessions (id, title, created_at, updated_at, mode, workspace) VALUES (?, ?, 1, 2, ?, ?)",
        [("s1", "a", "code", "/work/shop"), ("s2", "b", "code", "/work/blog")],
    )
    conn.commit()
    conn.close()
    monkeypatch.undo()

    store = Store(Database(path))
    projects = {p["name"]: p for p in store.list_projects()}
    assert set(projects) == {"shop", "blog"}, "one project per folder, the old one reused"
    assert store.get_session("s1")["project_id"] == projects["shop"]["id"]
    assert store.get_session("s2")["project_id"] == projects["blog"]["id"]


def test_the_library_groups_designs_by_design_project(store: Store, designs):
    groups = design_export.library(store)
    assert [g["name"] for g in groups] == ["Harbour Coffee", "Price list"]
    harbour, loose = groups
    assert {d["title"]: d["detail"] for d in harbour["designs"]} == {
        "Mobile app": "2 screens", "Landing page": "1 line"}
    assert loose["project"] is None and [d["title"] for d in loose["designs"]] == ["Prices"]
    assert "Notes" not in json.dumps(groups), "a chat's canvas is not a design"

    items, problem = design_export.find(store, "mobile", None)
    assert problem is None and [i["id"] for i in items] == [designs["wire"].id]
    items, problem = design_export.find(store, None, "harbour coffee")
    assert {i["title"] for i in items} == {"Mobile app", "Landing page"}
    _, problem = design_export.find(store, "Nope", None)
    assert "Mobile app" in problem and "Prices" in problem


def test_designs_are_written_as_files_a_coder_can_use(store: Store, base: Path, designs):
    root = base / "app"
    root.mkdir()
    ids = [designs["wire"].id, designs["page"].id, designs["sheet"].id]
    written = design_export.export(store, ids, root)
    folder = root / "design"
    assert written[:2] == ["design/README.md", "design/index.json"]
    index = (folder / "README.md").read_text()
    assert "| Mobile app | Wireframe (DESIGN.md) | Harbour Coffee / Landing ideas |" in index
    assert "| Prices | Sheet | Price list |" in index

    spec = (folder / "mobile-app" / "spec.md").read_text()
    assert "## Flow" in spec and '"See menu"' in spec and "→ Menu" in spec
    assert "f1_l3 button" in spec, "the layer outline is in the spec"
    screen = (folder / "mobile-app" / "01-home.html").read_text()
    assert "Harbour Coffee" in screen and "../images/latte-art-" in screen
    assert json.loads((folder / "mobile-app" / "wireframe.json").read_text())["frames"][1]["name"] == "Menu"

    page = (folder / "landing-page.html").read_text()
    assert "bom-image:" not in page and 'src="images/latte-art-' in page
    pictures = list((folder / "images").iterdir())
    assert len(pictures) == 1 and pictures[0].read_bytes() == PNG
    assert (folder / "prices.csv").read_text() == "Drink,Price\nFlat white,4.2\nMocha,=B2+1\n"
    assert "Swiss" in (folder / "DESIGN.md").read_text()
    assert "`DESIGN.md`" in index

    again = design_export.export(store, ids, root)
    assert sorted(again) == sorted(written), "exporting again refreshes the same files"


def test_exports_add_up_and_clear_their_own_leftovers(store: Store, base: Path, designs):
    root = base / "app"
    root.mkdir()
    design_export.export(store, [designs["wire"].id], root)
    design_export.export(store, [designs["sheet"].id], root)
    folder = root / "design"
    index = (folder / "README.md").read_text()
    assert "| Mobile app |" in index and "| Prices |" in index, "the second export kept the first"
    listed = json.loads((folder / "index.json").read_text())
    assert [d["title"] for d in listed["designs"]] == ["Mobile app", "Prices"]

    # The same title, from another conversation, gets a name of its own.
    other = store.create_session(title="Other", mode="design")["id"]
    twin = store.create_canvas(other, "Prices", kind="markdown", content="# Prices")
    design_export.export(store, [twin.id], root)
    assert (folder / "prices.csv").exists() and (folder / "prices-2.md").exists()

    # A screen deleted from the wireframe goes from the folder when it is
    # exported again; nothing else does.
    doc = json.loads(designs["wire"].content)
    doc["frames"] = doc["frames"][:1]
    store.update_canvas(designs["wire"].id, content=json.dumps(doc))
    design_export.export(store, [designs["wire"].id], root)
    assert (folder / "mobile-app" / "01-home.html").exists()
    assert not (folder / "mobile-app" / "02-menu.html").exists()
    assert (folder / "prices.csv").exists() and (folder / "prices-2.md").exists()


# -- the tools ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_project_files_the_conversation(store: Store, base: Path):
    tools = _tools(store, base)
    sid = store.create_session(mode="design")["id"]
    said = await tools["create_project"].use(session=sid, name="Harbour Coffee")
    record = store.find_project("Harbour Coffee", "design")
    assert "Made the design project" in said and store.get_session(sid)["project_id"] == record["id"]
    again = await tools["create_project"].use(session=sid, name="harbour coffee")
    assert "already exists" in again and len(store.list_projects("design")) == 1

    chat = store.create_session()["id"]
    said = await tools["create_project"].use(session=chat, name="Harbour Coffee", kind="design")
    assert "not a design conversation" in said and store.get_session(chat)["project_id"] is None


@pytest.mark.asyncio
async def test_a_code_project_is_built_from_a_design_project(store: Store, base: Path, designs):
    tools = _tools(store, base)
    assert tools["create_code_project"].must_ask and tools["import_design"].must_ask
    assert not tools["list_designs"].must_ask

    sid = store.create_session(mode="code")["id"]
    said = await tools["create_code_project"].use(
        session=sid, name="Harbour App", from_design="Harbour Coffee")
    root = base / "BomProjects" / "harbour-app"
    assert f"at {root}" in said and "2 designs were written" in said
    assert (root / "design" / "mobile-app" / "spec.md").exists()
    assert (root / "design" / "landing-page.html").exists()
    assert not (root / "design" / "prices.csv").exists(), "only that project's designs"
    assert "design/README.md" in (root / "README.md").read_text()

    record = store.code_project_at(str(root))
    assert record["kind"] == "code" and record["source_id"] == designs["project"]["id"]
    assert store.session_workspace(sid) == str(root), "a folder-less code chat moves in"
    assert store.get_session(sid)["project_id"] == record["id"]

    listed = await tools["list_designs"].use(session=sid)
    assert "this code project was built from it" in listed and '"Prices"' in listed

    other = await tools["create_code_project"].use(session=sid, name="Harbour App")
    assert "harbour-app-2" in other and "stays on its own folder" in other

    missing = await tools["create_code_project"].use(session=None, name="X", from_design="Nope")
    assert "no design project called" in missing


@pytest.mark.asyncio
async def test_a_code_project_needs_a_projects_folder_it_may_use(store: Store, base: Path, tmp_path):
    tools = _tools(store, base, projects_dir=tmp_path / "elsewhere")
    said = await tools["create_code_project"].use(session=None, name="X")
    assert "outside the folders projects may live in" in said
    assert not (tmp_path / "elsewhere").exists()


@pytest.mark.asyncio
async def test_designs_are_read_and_imported_in_a_code_conversation(store: Store, base: Path, designs):
    tools = _tools(store, base)
    root = base / "site"
    root.mkdir()
    sid = store.create_session(mode="code", workspace=str(root))["id"]

    read = await tools["read_design"].use(design="Mobile app")
    assert read.startswith("Mobile app (wireframe) -- from \"Landing ideas\"")
    assert 'frame f1 "Home"' in read and "→ f2" in read
    sheet = await tools["read_design"].use(design="Prices", project="Price list")
    assert "Flat white" in sheet

    result = await tools["import_design"].use(session=sid, project="Harbour Coffee", into="docs/design")
    assert "docs/design/README.md" in result.paths
    assert (root / "docs" / "design" / "landing-page.html").exists()
    refused = await tools["import_design"].use(session=sid, design="Prices", into="../out")
    assert "could not be written" in refused and not (base / "out").exists()


# -- the turn -----------------------------------------------------------------------


class _Model:
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


def _orchestrator(store, base, provider):
    registry = Registry()
    for skill in (*code_skills(store, _settings(base), CodeState()), *project_skills(store, _settings(base))):
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
async def test_making_a_code_project_is_asked_about_and_announced(store: Store, base: Path, designs):
    provider = _Model([("create_code_project", {"name": "Harbour", "from_design": "Harbour Coffee"})])
    orch = _orchestrator(store, base, provider)
    sid = store.create_session(mode="design")["id"]
    seen = ""
    async for frame in orch.run_turn(sid, "Build this as an app"):
        seen += frame
        if "event: skill_approval" in frame:
            request = json.loads(frame.split("data: ", 1)[1])
            assert request["name"] == "create_code_project"
            orch.approvals.resolve(request["id"], "allow_once")
    assert "event: projects\n" in seen
    assert (base / "BomProjects" / "harbour" / "design" / "README.md").exists()
    assert {"create_code_project", "list_designs", "create_project"} <= provider.tools[0]
    assert not {"read_design", "import_design"} & provider.tools[0], "those are for code"


@pytest.mark.asyncio
async def test_a_code_turn_knows_the_designs_it_was_built_from(store: Store, base: Path, designs):
    tools = _tools(store, base)
    await tools["create_code_project"].use(session=None, name="Harbour", from_design="Harbour Coffee")
    root = base / "BomProjects" / "harbour"
    sid = store.create_session(mode="code", workspace=str(root))["id"]
    provider = _Model([])
    orch = _orchestrator(store, base, provider)
    [f async for f in orch.run_turn(sid, "hello")]
    assert 'built from the design project "Harbour Coffee"' in provider.systems[0]
    assert {"read_design", "import_design", "list_designs"} <= provider.tools[0]
    assert "create_project" not in provider.tools[0]


@pytest.mark.asyncio
async def test_a_code_turn_files_its_conversation_under_its_folder(store: Store, base: Path):
    root = base / "loose"
    root.mkdir()
    sid = store.create_session(mode="code", workspace=str(root))["id"]
    store.delete_project(store.get_session(sid)["project_id"])
    assert store.get_session(sid)["project_id"] is None
    orch = _orchestrator(store, base, _Model([]))
    [f async for f in orch.run_turn(sid, "hello")]
    record = store.code_project_at(str(root))
    assert record and store.get_session(sid)["project_id"] == record["id"]


# -- the API --------------------------------------------------------------------------


@pytest.fixture
def client(tmp_path: Path, base: Path) -> TestClient:
    settings = Settings(
        db_path=tmp_path / "api.db", auth_token="t", workspace_roots=(base,),
        projects_dir=base / "BomProjects",
    )
    return TestClient(create_app(settings), headers={"Authorization": "Bearer t"})


def _design(client, title="Home") -> tuple[str, str, str]:
    """A design project holding a design conversation holding a page."""
    project = client.post("/api/projects", json={"name": "Harbour", "kind": "design"}).json()
    session = client.post("/api/sessions", json={"mode": "design"}).json()
    assert client.put(f"/api/sessions/{session['id']}/project", json={"project_id": project["id"]}).status_code == 200
    canvas = client.post(
        f"/api/sessions/{session['id']}/canvases",
        json={"title": title, "kind": "html", "content": "<h1>Harbour</h1>"},
    ).json()
    return project["id"], session["id"], canvas["id"]


def test_projects_are_made_of_each_kind(client, base):
    design_id, session_id, canvas_id = _design(client)
    library = client.get("/api/designs/library").json()["groups"]
    assert library[0]["project_id"] == design_id and library[0]["designs"][0]["id"] == canvas_id

    made = client.post("/api/projects", json={"name": "Harbour Site", "kind": "code", "source_id": design_id})
    assert made.status_code == 200, made.text
    body = made.json()
    root = base / "BomProjects" / "harbour-site"
    assert body["kind"] == "code" and body["root"] == str(root) and body["source_id"] == design_id
    assert "design/home.html" in body["written"] and (root / "design" / "home.html").exists()
    listed = {p["name"]: p for p in client.get("/api/projects").json()["projects"]}
    assert listed["Harbour Site"]["missing"] is False and listed["Harbour"]["kind"] == "design"

    existing = base / "old"
    existing.mkdir()
    registered = client.post("/api/projects", json={"name": "Old", "kind": "code", "folder": str(existing)}).json()
    assert registered["path"] == str(existing) and registered["written"] == []
    assert client.post("/api/projects", json={"name": "x", "kind": "code", "folder": "/"}).status_code == 400
    assert client.post("/api/projects", json={"name": "x", "kind": "boat"}).status_code == 400
    assert client.post("/api/projects", json={"name": "x", "kind": "code", "designs": ["cnv_nope"]}).status_code == 404

    imported = client.post("/api/workspace/designs", json={"root": str(existing), "designs": [canvas_id]})
    assert imported.status_code == 200 and (existing / "design" / "home.html").exists()


def test_a_project_holds_its_own_kind_of_conversation(client, base):
    design_id, design_session, _ = _design(client)
    chat_project = client.post("/api/projects", json={"name": "Misc"}).json()
    assert chat_project["kind"] == "chat"
    chat = client.post("/api/sessions", json={}).json()
    put = lambda sid, pid: client.put(f"/api/sessions/{sid}/project", json={"project_id": pid})

    assert put(chat["id"], design_id).status_code == 400
    assert put(chat["id"], chat_project["id"]).status_code == 200
    assert put(design_session, chat_project["id"]).status_code == 200, "as before: chats hold designs too"

    one, two = base / "one", base / "two"
    one.mkdir(), two.mkdir()
    code = client.post("/api/sessions", json={"mode": "code", "workspace": str(one)}).json()
    other = client.post("/api/projects", json={"name": "Two", "kind": "code", "folder": str(two)}).json()
    assert put(code["id"], chat_project["id"]).status_code == 400
    assert put(chat["id"], other["id"]).status_code == 400
    moved = put(code["id"], other["id"])
    assert moved.status_code == 200 and moved.json()["workspace"] == str(two)
    session = client.get(f"/api/sessions/{code['id']}").json()["session"]
    assert session["workspace"] == str(two) and session["project_id"] == other["id"]

    gone = client.delete(f"/api/projects/{other['id']}").json()
    assert gone["files"] == "untouched" and two.exists()


def test_a_new_conversation_is_filed_from_its_first_message(client, base, monkeypatch):
    # The composer's project picker: the project rides on the first message,
    # and the conversation is filed before the turn runs -- by the same rules
    # as filing it afterwards.
    async def fake_run_turn(self, session_id, text, **kw):
        yield "event: done\ndata: {}\n\n"

    monkeypatch.setattr(Orchestrator, "run_turn", fake_run_turn)
    chats = client.post("/api/projects", json={"name": "Misc"}).json()
    designs = client.post("/api/projects", json={"name": "Looks", "kind": "design"}).json()

    def first(**extra):
        r = client.post("/api/chat", json={"message": "hi", **extra})
        r.read()
        return r

    filed = first(project_id=chats["id"])
    assert filed.status_code == 200
    listed = client.get("/api/sessions").json()["sessions"]
    assert listed[0]["project_id"] == chats["id"]

    before = len(listed)
    assert first(project_id=designs["id"]).status_code == 400, "a chat is not a design"
    assert first(project_id="prj_nope").status_code == 404
    assert len(client.get("/api/sessions").json()["sessions"]) == before, "nothing left behind"

    assert first(project_id=designs["id"], mode="design").status_code == 200
