"""Design standards: presets, the reader's own, and the question a turn stops on."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.choices import Choices
from app.config import Settings
from app.db import Database
from app.design_presets import PRESETS
from app.main import create_app
from app.orchestrator import Orchestrator
from app.providers.base import Chunk, ToolCall
from app.skills.design import NO_DESIGN, AskForDesign, options, resolve
from app.skills.registry import Registry
from app.store import Store


@pytest.fixture
def store(tmp_path: Path) -> Store:
    return Store(Database(tmp_path / "design.db"))


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    settings = Settings(db_path=tmp_path / "design_api.db", auth_token="t")
    return TestClient(create_app(settings), headers={"Authorization": "Bearer t"})


# -- the documents themselves -------------------------------------------------


def test_every_preset_is_a_usable_document():
    assert len(PRESETS) >= 6
    ids = [p["id"] for p in PRESETS]
    assert len(ids) == len(set(ids)), "preset ids must be unique"
    for preset in PRESETS:
        assert preset["name"] and preset["summary"]
        md = preset["markdown"]
        # A design.md the model can actually follow: a title and the headings
        # every preset promises, so the shape is the same whichever is picked.
        assert md.startswith("# "), preset["id"]
        for heading in ("## Principles", "## Type", "## Colour", "## Layout",
                        "## Components", "## Voice"):
            assert heading in md, f"{preset['id']} is missing {heading}"


def test_options_list_presets_and_custom_without_the_documents(store: Store):
    store.create_design("House style", "# House", summary="Ours")
    listed = options(store)
    assert len(listed) == len(PRESETS) + 1
    assert listed[-1]["source"] == "custom"
    assert {o["source"] for o in listed} == {"preset", "custom"}
    # The chooser renders names, not documents -- sending eight full design.md
    # files to draw eight rows would be most of a megabyte.
    assert all("markdown" not in option for option in listed)


def test_resolve_finds_presets_and_custom_designs(store: Store):
    design = store.create_design("House style", "# House\n\nBody 16px.")
    assert resolve(store, "swiss")[0] == "Swiss"
    assert resolve(store, design.id) == ("House style", "# House\n\nBody 16px.")
    assert resolve(store, "nope") is None


# -- the skill ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_skill_hands_back_the_chosen_document(store: Store):
    skill = AskForDesign(store)
    chosen = await skill.use(session="s", choice="swiss")
    assert "Swiss" in chosen
    assert "## Type" in chosen  # the document itself, not just its name


@pytest.mark.asyncio
async def test_declining_is_an_answer_not_an_error(store: Store):
    skill = AskForDesign(store)
    for choice in (NO_DESIGN, ""):
        out = await skill.use(session="s", choice=choice)
        assert "did not choose" in out
        assert "own judgement" in out


# -- the question the turn stops on -------------------------------------------


class _AsksForDesign:
    """Calls ask_for_design once, then answers."""

    name = "mock"
    model = "mock"

    def __init__(self) -> None:
        self.calls = 0

    async def stream(self, messages, *, think=None, tools=None):
        self.calls += 1
        if self.calls == 1:
            yield Chunk(
                done=True,
                tool_calls=(ToolCall(id="d1", name="ask_for_design", arguments={}),),
            )
        else:
            yield Chunk(text="Written to the standard.", done=True)

    async def embed(self, texts):
        return [[0.0] * 8 for _ in texts]

    async def health(self):
        return True


def _orchestrator(store: Store) -> Orchestrator:
    registry = Registry()
    registry.register(AskForDesign(store))
    provider = _AsksForDesign()
    router = type("R", (), {})()
    router.resolve = lambda prefer=None: _route(provider)
    router.invalidate_health = lambda: None
    settings = type(
        "S", (),
        {
            "system_preamble": "You help.", "context_tokens": 8192,
            "reply_tokens": 1024, "ollama_think": "medium",
            "memory_max_facts": 20, "memory_fact_chars": 200,
        },
    )()
    return Orchestrator(settings, store, router, registry)


async def _route(provider):
    return type("Route", (), {"provider": provider, "reason": "local"})()


@pytest.mark.asyncio
async def test_the_turn_stops_asks_and_uses_the_answer(store: Store):
    orch = _orchestrator(store)
    sid = store.create_session()["id"]

    frames: list[str] = []
    async for frame in orch.run_turn(sid, "Write me a report"):
        frames.append(frame)
        # Answer the question the moment it is asked, the way the client does
        # on a separate request while this turn is still streaming.
        if "event: design_choice" in frame:
            payload = json.loads(frame.split("data: ", 1)[1])
            assert len(payload["options"]) == len(PRESETS)
            orch.choices.resolve(payload["id"], "swiss")

    joined = "".join(frames)
    assert "event: design_choice" in joined
    # The chosen document came back as the skill's result, so the model had it
    # in the window for the round that actually wrote the thing.
    assert "Swiss" in joined and "Order before ornament" in joined
    assert "Written to the standard." in joined


@pytest.mark.asyncio
async def test_an_unanswered_question_lets_the_turn_carry_on(store: Store):
    orch = _orchestrator(store)
    # Nobody is going to answer, so the question should take its default
    # rather than hold the turn open or kill it.
    orch.choices = Choices(timeout=0.05)
    sid = store.create_session()["id"]

    joined = "".join([f async for f in orch.run_turn(sid, "Write me a report")])
    assert "did not choose" in joined
    assert "Written to the standard." in joined


# -- HTTP ---------------------------------------------------------------------


def test_design_rest_lifecycle(client: TestClient):
    assert len(client.get("/api/designs/presets").json()["presets"]) >= 6
    assert client.get("/api/designs").json()["designs"] == []

    made = client.post(
        "/api/designs",
        json={"name": "House", "summary": "Ours", "markdown": "# House\n\nBody 16px."},
    )
    assert made.status_code == 200
    assert made.json()["source"] == "custom"
    design_id = made.json()["id"]

    patched = client.patch(f"/api/designs/{design_id}", json={"summary": "v2"})
    assert patched.json()["summary"] == "v2"
    assert patched.json()["markdown"] == "# House\n\nBody 16px."

    assert client.delete(f"/api/designs/{design_id}").status_code == 200
    assert client.delete(f"/api/designs/{design_id}").status_code == 404


def test_answering_a_question_nobody_is_holding_is_a_404(client: TestClient):
    assert client.post("/api/chat/design/nope", json={"choice": "swiss"}).status_code == 404
