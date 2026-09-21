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
from app.skills.design import NO_DESIGN, AskForDesign, match, options, resolve
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
    """Calls ask_for_design once, then answers.

    `arguments` is what the model passes on that call -- empty for "show them
    the list", or a name for "they already said which one".
    """

    name = "mock"
    model = "mock"

    def __init__(self, arguments: dict | None = None) -> None:
        self.calls = 0
        self.arguments = arguments or {}
        # What the model was offered, so a test can check the tool it is being
        # sold is the one that would actually get used.
        self.tools_seen: list = []

    async def stream(self, messages, *, think=None, tools=None):
        self.calls += 1
        self.tools_seen.append(tools)
        if self.calls == 1:
            yield Chunk(
                done=True,
                tool_calls=(
                    ToolCall(id="d1", name="ask_for_design", arguments=self.arguments),
                ),
            )
        else:
            yield Chunk(text="Written to the standard.", done=True)

    async def embed(self, texts):
        return [[0.0] * 8 for _ in texts]

    async def health(self):
        return True


def _orchestrator(store: Store, arguments: dict | None = None) -> Orchestrator:
    registry = Registry()
    registry.register(AskForDesign(store))
    provider = _AsksForDesign(arguments)
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
    orchestrator = Orchestrator(settings, store, router, registry)
    # Handed back on the orchestrator so a test can read what the model saw.
    orchestrator.provider_under_test = provider
    return orchestrator


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


# -- a standard the user named ------------------------------------------------
#
# The bug these cover: the skill used to tell the model not to call it when the
# user had already named a style, so "use the brutalist web design.md" sent it
# hunting the filesystem for a file that has never existed, and it came back
# apologising. A named standard has to resolve to a document without anyone
# touching a disk and without a second question.


@pytest.mark.parametrize(
    "named, expected",
    [
        ("brutalist web design.md", "brutalist"),
        ("Brutalist web", "brutalist"),
        ("brutalist", "brutalist"),
        ("BRUTALIST WEB DESIGN.MD", "brutalist"),
        ("the Swiss style", "swiss"),
        ("swiss", "swiss"),
        ("Business memo", "memo"),
        ("memo", "memo"),
        ("Soft product UI", "soft"),
        ("academic paper design.md", "academic"),
        # Exact tag, as the last resort.
        ("typographic", "swiss"),
    ],
)
def test_a_named_standard_reaches_its_preset(store: Store, named, expected):
    assert match(store, named) == expected


@pytest.mark.parametrize(
    "named",
    [
        "",
        "   ",
        # A four-letter id inside an unrelated phrase. "soft" must not be
        # dragged out of "a software architecture write-up".
        "a software architecture write-up",
        "something nobody has ever saved",
    ],
)
def test_a_name_that_fits_nothing_matches_nothing(store: Store, named):
    assert match(store, named) is None


def test_the_readers_own_standard_wins_over_a_preset_of_the_same_name(store: Store):
    mine = store.create_design("Editorial", "# Mine\n\nNot the magazine one.")
    assert match(store, "Editorial") == mine.id
    assert match(store, "editorial") == mine.id


@pytest.mark.asyncio
async def test_naming_a_standard_skips_the_question_entirely(store: Store):
    """The whole point: they already answered, so nothing is asked."""
    orch = _orchestrator(store, {"name": "brutalist web design.md"})
    sid = store.create_session()["id"]

    frames = [f async for f in orch.run_turn(sid, "Rewrite it brutalist")]
    joined = "".join(frames)

    # No chooser, and the document still arrived.
    assert "event: design_choice" not in joined
    assert "Brutalist web" in joined
    assert "Written to the standard." in joined


@pytest.mark.asyncio
async def test_a_name_that_matches_nothing_falls_back_to_the_list(store: Store):
    """Better than an apology: show what there actually is, and say why."""
    orch = _orchestrator(store, {"name": "the one my old designer made"})
    sid = store.create_session()["id"]

    frames: list[str] = []
    async for frame in orch.run_turn(sid, "Use that one"):
        frames.append(frame)
        if "event: design_choice" in frame:
            payload = json.loads(frame.split("data: ", 1)[1])
            # The chooser is told what was asked for, so it can explain itself
            # rather than appearing out of nowhere.
            assert payload["asked_for"] == "the one my old designer made"
            orch.choices.resolve(payload["id"], "swiss")

    joined = "".join(frames)
    assert "event: design_choice" in joined
    assert "Order before ornament" in joined


@pytest.mark.asyncio
async def test_the_model_is_told_these_are_not_files(store: Store):
    """The description is the only thing standing between a named standard and
    a read_file call, so it is worth a test of its own."""
    orch = _orchestrator(store)
    sid = store.create_session()["id"]
    orch.choices = Choices(timeout=0.05)
    async for _ in orch.run_turn(sid, "Write me a report"):
        pass

    offered = orch.provider_under_test.tools_seen[0]
    schema = next(t for t in offered if t["name"] == "ask_for_design")
    assert "never a file" in schema["description"].lower()
    assert "read_file" in schema["description"]
    # And the name is something the model can actually pass.
    assert "name" in schema["parameters"]["properties"]
