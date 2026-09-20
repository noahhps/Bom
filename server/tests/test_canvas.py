"""The canvas: its store methods, the two skills, and the HTTP surface."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.db import Database
from app.main import create_app
from app.orchestrator import Orchestrator
from app.providers.base import Chunk, ToolCall
from app.providers.router import ProviderRouter
from app.skills.canvas import ReadCanvas, WriteCanvas
from app.skills.registry import Registry
from app.store import Store


@pytest.fixture
def store(tmp_path: Path) -> Store:
    return Store(Database(tmp_path / "canvas.db"))


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    settings = Settings(db_path=tmp_path / "canvas_api.db", auth_token="test_token")
    app = create_app(settings)
    return TestClient(app, headers={"Authorization": "Bearer test_token"})


# -- store --------------------------------------------------------------------


def test_create_and_list_canvases_scopes_to_session(store: Store):
    a = store.create_session()["id"]
    b = store.create_session()["id"]
    store.create_canvas(a, "Draft", content="one")
    store.create_canvas(a, "Notes", content="two")
    store.create_canvas(b, "Elsewhere", content="three")

    titles_a = {c.title for c in store.session_canvases(a)}
    assert titles_a == {"Draft", "Notes"}
    assert [c.title for c in store.session_canvases(b)] == ["Elsewhere"]


def test_find_canvas_by_title_is_case_insensitive(store: Store):
    sid = store.create_session()["id"]
    store.create_canvas(sid, "Draft", content="x")
    assert store.find_canvas_by_title(sid, "draft").title == "Draft"
    assert store.find_canvas_by_title(sid, "DRAFT") is not None
    assert store.find_canvas_by_title(sid, "missing") is None


def test_update_canvas_merges_only_named_fields(store: Store):
    sid = store.create_session()["id"]
    c = store.create_canvas(sid, "Draft", content="body", kind="markdown")
    updated = store.update_canvas(c.id, content="new body")
    assert updated.content == "new body"
    # Untouched fields survive a content-only edit.
    assert updated.title == "Draft"
    assert updated.kind == "markdown"


def test_deleting_the_session_takes_its_canvases(store: Store):
    sid = store.create_session()["id"]
    store.create_canvas(sid, "Draft", content="x")
    store.delete_session(sid)
    assert store.session_canvases(sid) == []


def test_delete_canvas_reports_whether_it_existed(store: Store):
    sid = store.create_session()["id"]
    c = store.create_canvas(sid, "Draft")
    assert store.delete_canvas(c.id) is True
    assert store.delete_canvas(c.id) is False


# -- skills -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_write_canvas_creates_then_replaces_by_title(store: Store):
    sid = store.create_session()["id"]
    skill = WriteCanvas(store)

    first = await skill.use(session=sid, title="Draft", content="hello\nworld")
    assert "Created" in first
    assert len(store.session_canvases(sid)) == 1

    # Same title, different case -- still the same canvas, replaced.
    second = await skill.use(session=sid, title="draft", content="rewritten")
    assert "Updated" in second
    canvases = store.session_canvases(sid)
    assert len(canvases) == 1
    assert canvases[0].content == "rewritten"


@pytest.mark.asyncio
async def test_write_canvas_infers_code_kind_from_language(store: Store):
    sid = store.create_session()["id"]
    skill = WriteCanvas(store)
    await skill.use(session=sid, title="Script", content="print(1)", language="python")
    canvas = store.find_canvas_by_title(sid, "Script")
    assert canvas.kind == "code"
    assert canvas.language == "python"


@pytest.mark.asyncio
async def test_write_canvas_needs_a_title(store: Store):
    sid = store.create_session()["id"]
    skill = WriteCanvas(store)
    result = await skill.use(session=sid, title="   ", content="x")
    assert "title" in result.lower()
    assert store.session_canvases(sid) == []


@pytest.mark.asyncio
async def test_read_canvas_lists_and_reads(store: Store):
    sid = store.create_session()["id"]
    write, read = WriteCanvas(store), ReadCanvas(store)

    assert "no canvases" in (await read.use(session=sid)).lower()

    await write.use(session=sid, title="Draft", content="the body")
    listing = await read.use(session=sid)
    assert "Draft" in listing

    body = await read.use(session=sid, title="Draft")
    assert "the body" in body

    missing = await read.use(session=sid, title="Nope")
    assert "no canvas called" in missing.lower()


# -- HTTP ---------------------------------------------------------------------


def test_canvas_rest_lifecycle(client: TestClient):
    session_id = client.post("/api/sessions").json()["id"]

    # Empty to start.
    listed = client.get(f"/api/sessions/{session_id}/canvases")
    assert listed.status_code == 200
    assert listed.json()["canvases"] == []

    # Create.
    created = client.post(
        f"/api/sessions/{session_id}/canvases",
        json={"title": "Draft", "content": "hello", "kind": "markdown"},
    )
    assert created.status_code == 200
    canvas_id = created.json()["id"]

    # A reader's edit merges.
    patched = client.patch(f"/api/canvases/{canvas_id}", json={"content": "edited"})
    assert patched.status_code == 200
    assert patched.json()["content"] == "edited"
    assert patched.json()["title"] == "Draft"

    # Delete, then it is gone.
    assert client.delete(f"/api/canvases/{canvas_id}").status_code == 200
    assert client.get(f"/api/sessions/{session_id}/canvases").json()["canvases"] == []


def test_canvas_routes_404_on_missing(client: TestClient):
    assert client.get("/api/sessions/ses_nope/canvases").status_code == 404
    assert client.patch("/api/canvases/cnv_nope", json={"content": "x"}).status_code == 404
    assert client.delete("/api/canvases/cnv_nope").status_code == 404


# -- orchestrator -------------------------------------------------------------


class _CanvasProvider:
    """Asks for write_canvas on the first round, then answers."""

    name = "mock"
    model = "mock"

    def __init__(self) -> None:
        self.calls = 0

    async def stream(self, messages, *, think=None, tools=None):
        self.calls += 1
        if self.calls == 1:
            yield Chunk(
                text="Drafting.",
                done=True,
                tool_calls=(
                    ToolCall(
                        id="c1",
                        name="write_canvas",
                        arguments={"title": "Draft", "content": "the body"},
                    ),
                ),
            )
        else:
            yield Chunk(text="Done — it's in the panel.", done=True)

    async def embed(self, texts):
        return [[0.0] * 8 for _ in texts]

    async def health(self):
        return True


@pytest.mark.asyncio
async def test_write_canvas_emits_a_canvas_frame(store: Store):
    registry = Registry()
    registry.register(WriteCanvas(store))
    provider = _CanvasProvider()

    router = ProviderRouter.__new__(ProviderRouter)
    router.resolve = lambda prefer=None: _route(provider)
    router.invalidate_health = lambda: None

    settings = type(
        "S",
        (),
        {
            "system_preamble": "You help.",
            "context_tokens": 8192,
            "reply_tokens": 1024,
            "ollama_think": "medium",
            "memory_max_facts": 20,
            "memory_fact_chars": 200,
        },
    )()

    orchestrator = Orchestrator(settings, store, router, registry)
    session_id = store.create_session()["id"]

    frames = []
    async for frame in orchestrator.run_turn(session_id, "Draft something"):
        frames.append(frame)
    joined = "".join(frames)

    # The dedicated frame carrying the fresh canvas to the client, and the
    # canvas actually persisted behind it.
    assert "event: canvas" in joined
    assert "the body" in joined
    canvases = store.session_canvases(session_id)
    assert len(canvases) == 1 and canvases[0].title == "Draft"


async def _route(provider):
    return type("Route", (), {"provider": provider, "reason": "local"})()
