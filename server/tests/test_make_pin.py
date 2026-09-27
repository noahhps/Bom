"""The composer's Make menu: pinning a turn to one way of making something."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.db import Database
from app.main import create_app

from app.design_mode import DESIGN, DESIGN_PREAMBLE, blocked_by, pinned
from app.orchestrator import Orchestrator
from app.providers.base import Chunk, ToolCall
from app.skills.canvas import ReadCanvas, WriteCanvas
from app.skills.registry import Registry
from app.skills.sheet import WriteSheet
from app.skills.slides import WriteSlides
from app.skills.wireframe import WireframeToSlides, WriteWireframe
from app.store import Store


@pytest.fixture
def store(tmp_path: Path) -> Store:
    return Store(Database(tmp_path / "pin.db"))


class _Scripted:
    name = "mock"
    model = "mock"

    def __init__(self, *rounds):
        self.rounds = list(rounds)
        self.tools: list = []
        self.systems: list[str] = []

    async def stream(self, messages, *, think=None, tools=None):
        self.tools.append({t["name"] for t in tools or []})
        self.systems.append(messages[0].content)
        if self.rounds:
            calls = self.rounds.pop(0)
            yield Chunk(done=True, tool_calls=tuple(
                ToolCall(id=f"c{i}", name=n, arguments=a) for i, (n, a) in enumerate(calls)))
        else:
            yield Chunk(text="Made it.", done=True)

    async def embed(self, texts):
        return [[0.0] * 8 for _ in texts]

    async def health(self):
        return True


def _orchestrator(store: Store, *rounds) -> tuple[Orchestrator, _Scripted]:
    registry = Registry()
    for skill in (WriteWireframe(store), WireframeToSlides(store), WriteSlides(store),
                  WriteSheet(store), WriteCanvas(store), ReadCanvas(store)):
        registry.register(skill)
    provider = _Scripted(*rounds)

    async def resolve(prefer=None):
        return type("Route", (), {"provider": provider, "reason": "local"})()

    router = type("R", (), {})()
    router.resolve = resolve
    router.invalidate_health = lambda: None
    settings = type("S", (), {
        "system_preamble": "You help.", "context_tokens": 8192, "reply_tokens": 1024,
        "ollama_think": "medium", "memory_max_facts": 20, "memory_fact_chars": 200,
    })()
    return Orchestrator(settings, store, router, registry), provider


async def _run(orch, sid, text, make=None) -> str:
    return "".join([frame async for frame in orch.run_turn(sid, text, make=make)])


WIRE = ("write_wireframe", {"title": "App", "frames": [{"name": "Home", "layers": [{"type": "h1", "text": "Hi"}]}]})
DECK = ("write_slides", {"title": "Pitch", "slides": [{"title": "Hello"}]})


def test_unknown_or_auto_pins_nothing():
    assert pinned(None) is None and pinned("auto") is None and pinned("poster") is None
    assert pinned("Wireframe")["tool"] == "write_wireframe"
    # A pinned presentation can still be made from a wireframe; nothing else.
    assert "wireframe_to_slides" not in blocked_by(pinned("slides"))
    assert {"write_wireframe", "write_sheet", "write_canvas"} <= blocked_by(pinned("slides"))


@pytest.mark.asyncio
async def test_a_pinned_turn_offers_only_that_way_of_making(store: Store):
    orch, provider = _orchestrator(store, [WIRE])
    sid = store.create_session()["id"]
    await _run(orch, sid, "Something for the launch", make="wireframe")
    offered = provider.tools[0]
    assert "write_wireframe" in offered and "read_canvas" in offered
    assert not offered & {"write_slides", "write_sheet", "write_canvas", "wireframe_to_slides"}
    assert "chose **Wireframe** in the composer's Make menu" in provider.systems[0]
    assert store.session_canvases(sid)[0].kind == "wireframe"


@pytest.mark.asyncio
async def test_a_model_that_reaches_past_the_pin_is_refused(store: Store):
    orch, provider = _orchestrator(store, [DECK], [WIRE])
    sid = store.create_session()["id"]
    joined = await _run(orch, sid, "A pitch", make="wireframe")
    assert "write_slides did not run: the user chose Wireframe" in joined
    kinds = [c.kind for c in store.session_canvases(sid)]
    assert kinds == ["wireframe"]


@pytest.mark.asyncio
async def test_auto_leaves_every_tool_and_says_nothing(store: Store):
    orch, provider = _orchestrator(store)
    sid = store.create_session()["id"]
    await _run(orch, sid, "Hello", make="auto")
    assert {"write_wireframe", "write_slides", "write_sheet", "write_canvas"} <= provider.tools[0]
    assert "chose **" not in provider.systems[0]


@pytest.mark.asyncio
async def test_a_pin_to_a_switched_off_tool_is_ignored(store: Store):
    orch, provider = _orchestrator(store)
    orch.registry.set_enabled("write_wireframe", False)
    sid = store.create_session()["id"]
    await _run(orch, sid, "Hello", make="wireframe")
    assert "chose **" not in provider.systems[0]
    assert "write_slides" in provider.tools[0]


def test_design_conversations_start_from_a_wireframe():
    assert "Start from a wireframe" in DESIGN_PREAMBLE
    assert "choice wins over this default" in DESIGN_PREAMBLE


@pytest.mark.asyncio
async def test_the_pin_reaches_the_api(tmp_path: Path, monkeypatch):
    seen = {}

    async def fake_run_turn(self, session_id, text, **kw):
        seen.update(kw)
        yield "event: done\ndata: {}\n\n"

    monkeypatch.setattr(Orchestrator, "run_turn", fake_run_turn)
    app = create_app(Settings(auth_token="t", db_path=tmp_path / "c.db"))
    with TestClient(app) as client:
        r = client.post("/api/chat", json={"message": "hi", "make": "sheet", "mode": DESIGN},
                        headers={"Authorization": "Bearer t"})
        assert r.status_code == 200
        r.read()
    assert seen.get("make") == "sheet"
