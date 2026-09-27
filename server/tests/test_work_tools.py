"""The work tools -- slides and sheets -- and the design conversation around them."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.choices import Choices
from app.config import Settings
from app.db import Database
from app.design_mode import DESIGN_PREAMBLE
from app.design_presets import PRESETS, clean_theme, tokens_for
from app.main import create_app
from app.orchestrator import Orchestrator
from app.providers.base import Chunk, ToolCall
from app.skills.canvas import ReadCanvas, WriteCanvas
from app.skills.design import AskForDesign
from app.skills.registry import Registry
from app.skills.sheet import EditSheet, WriteSheet, column_index, column_letter
from app.skills.slides import WriteSlides, advice, normalize_deck
from app.store import Store


@pytest.fixture
def store(tmp_path: Path) -> Store:
    return Store(Database(tmp_path / "work.db"))


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    settings = Settings(db_path=tmp_path / "work_api.db", auth_token="t")
    return TestClient(create_app(settings), headers={"Authorization": "Bearer t"})


# -- themes -------------------------------------------------------------------


def test_every_preset_carries_a_complete_theme():
    for preset in PRESETS:
        tokens = preset["tokens"]
        for key in ("background", "surface", "text", "muted", "accent", "line",
                    "heading_font", "body_font"):
            assert tokens.get(key), f"{preset['id']} is missing {key}"
        # Tokens survive their own cleaning unchanged -- a preset that failed
        # validation would silently style nothing.
        assert clean_theme(tokens) == tokens, preset["id"]


def test_a_theme_cannot_smuggle_a_second_declaration():
    cleaned = clean_theme({
        "accent": "red; background: url(//evil)",
        "body_font": "Inter; x: url(//evil)",
        "background": "#FAFAFA",
        "radius": "999",
        "heading_weight": "650",
        "nonsense": "kept?",
    })
    assert cleaned == {"background": "#FAFAFA", "radius": 48, "heading_weight": 600}
    assert clean_theme('{"accent": "#E3000F"}') == {"accent": "#E3000F"}
    assert clean_theme("not json") == {}


# -- slides -------------------------------------------------------------------


def test_a_deck_is_normalised_to_known_layouts():
    deck = normalize_deck(
        [
            {"title": "Q3 review", "subtitle": "Where we landed"},
            {"layout": "divider", "title": "Numbers"},
            {"title": "Growth", "stats": [{"value": "42%", "label": "YoY"}]},
            {"title": "Plan", "points": "- Hire\n- Ship\n- Sell"},
            {"quote": "Make it simple.", "attribution": "Someone"},
            "Thanks",
            {},
        ]
    )
    layouts = [s["layout"] for s in deck["slides"]]
    assert layouts == ["title", "section", "stat", "bullets", "quote", "bullets"]
    assert deck["slides"][3]["bullets"] == ["Hire", "Ship", "Sell"]


def test_slides_arriving_as_json_text_still_make_a_deck():
    deck = normalize_deck(json.dumps([{"layout": "title", "title": "Hi"}]), '{"accent": "#123456"}')
    assert deck["slides"][0]["title"] == "Hi"
    assert deck["theme"] == {"accent": "#123456"}


def test_theme_layers_standard_then_model_then_override():
    deck = normalize_deck(
        [{"title": "x"}],
        theme={"accent": "#111111", "background": "#222222"},
        defaults={"accent": "#AAAAAA", "text": "#BBBBBB"},
        override={"background": "#FFFFFF"},
    )
    assert deck["theme"] == {"accent": "#111111", "text": "#BBBBBB", "background": "#FFFFFF"}


def test_a_visual_must_be_inline_svg():
    deck = normalize_deck([{"layout": "image", "title": "x", "visual": "<img src=x>"}])
    assert "visual" not in deck["slides"][0]
    deck = normalize_deck([{"layout": "image", "title": "x", "visual": "<svg viewBox='0 0 1 1'/>"}])
    assert deck["slides"][0]["visual"].startswith("<svg")


def test_advice_flags_what_a_designer_would():
    deck = normalize_deck(
        [{"layout": "bullets", "title": "t", "bullets": [f"point {i}" for i in range(7)]}] * 4
    )
    flagged = " ".join(advice(deck))
    assert "slides 1, 2, 3, 4 have more than 5 bullets" in flagged
    assert "vary the rhythm" in flagged
    assert "no theme" in flagged


@pytest.mark.asyncio
async def test_write_slides_makes_and_replaces_a_slides_canvas(store: Store):
    sid = store.create_session()["id"]
    skill = WriteSlides(store)
    said = await skill.use(session=sid, title="Pitch", slides=[{"title": "Hello"}])
    assert "Created the deck 'Pitch' (1 slide)" in said
    said = await skill.use(
        session=sid, title="pitch", slides=[{"title": "A"}, {"title": "B"}],
        design_defaults=tokens_for("swiss"),
    )
    assert "Updated" in said
    canvases = store.session_canvases(sid)
    assert len(canvases) == 1 and canvases[0].kind == "slides"
    stored = json.loads(canvases[0].content)
    assert len(stored["slides"]) == 2
    assert stored["theme"]["accent"] == "#E3000F"

    read = await ReadCanvas(store).use(session=sid, title="Pitch")
    assert "1. [title] A" in read and '"accent": "#E3000F"' in read


# -- sheets -------------------------------------------------------------------


def test_column_letters_round_trip():
    for index in (0, 1, 25, 26, 27, 51, 52, 701):
        assert column_index(column_letter(index)) == index
    assert column_letter(0) == "A" and column_letter(26) == "AA"


@pytest.mark.asyncio
async def test_write_sheet_coerces_numbers_and_keeps_formulas(store: Store):
    sid = store.create_session()["id"]
    said = await WriteSheet(store).use(
        session=sid,
        title="Budget",
        columns=["Item", "Cost", "Share"],
        rows=[["Rent", "$1,200", "40%"], ["Food", "300", "=B3/B4"], ["Total", "=SUM(B2:B3)", ""]],
        formats=["text", "currency", "percent"],
    )
    assert "rows 2-4" in said
    sheet = json.loads(store.session_canvases(sid)[0].content)
    assert sheet["rows"][0] == ["Rent", 1200, 0.4]
    assert sheet["rows"][1][1] == 300
    assert sheet["rows"][2][1] == "=SUM(B2:B3)"
    assert sheet["formats"] == ["text", "currency", "percent"]

    read = await ReadCanvas(store).use(session=sid, title="Budget")
    assert "1: A Item | B Cost | C Share" in read
    assert "4: Total | =SUM(B2:B3) | " in read


@pytest.mark.asyncio
async def test_a_sheet_without_formats_is_nudged(store: Store):
    sid = store.create_session()["id"]
    said = await WriteSheet(store).use(session=sid, title="T", columns=["a"], rows=[["x"]])
    assert "pass `formats`" in said


@pytest.mark.asyncio
async def test_edit_sheet_sets_appends_and_deletes(store: Store):
    sid = store.create_session()["id"]
    await WriteSheet(store).use(
        session=sid, title="T", columns=["Name", "Qty"], rows=[["a", 1], ["b", 2]],
        formats=["text", "integer"],
    )
    said = await EditSheet(store).use(
        session=sid, title="t",
        cells={"B2": "5", "A1": "Item", "C3": "=B3*2", "Z9x": 1},
        append_rows=[["c", 3]],
        delete_rows=[99],
    )
    assert "Edited" in said and "Skipped" in said
    sheet = json.loads(store.session_canvases(sid)[0].content)
    assert sheet["columns"] == ["Item", "Qty", "Column C"]
    assert sheet["rows"] == [["a", 5, ""], ["b", 2, "=B3*2"], ["c", 3, ""]]

    await EditSheet(store).use(session=sid, title="T", delete_rows=[2])
    sheet = json.loads(store.session_canvases(sid)[0].content)
    assert [r[0] for r in sheet["rows"]] == ["b", "c"]


@pytest.mark.asyncio
async def test_edit_sheet_refuses_what_is_not_a_sheet(store: Store):
    sid = store.create_session()["id"]
    store.create_canvas(sid, "Notes", content="hi")
    assert "not a sheet" in await EditSheet(store).use(session=sid, title="Notes", cells={"A2": 1})
    assert "no sheet called" in await EditSheet(store).use(session=sid, title="Nope")


# -- the canvas knows which calls have a look ---------------------------------


@pytest.mark.asyncio
async def test_write_canvas_points_decks_and_sheets_at_their_tools(store: Store):
    sid = store.create_session()["id"]
    canvas = WriteCanvas(store)
    assert "write_slides" in await canvas.use(session=sid, title="x", content="", kind="slides")
    assert "write_sheet" in await canvas.use(session=sid, title="x", content="", kind="sheet")
    assert store.session_canvases(sid) == []

    assert canvas.wants_design({"kind": "html", "content": ""})
    assert canvas.wants_design({"content": "<!doctype html><html></html>"})
    assert not canvas.wants_design({"kind": "code", "content": "<html>"})
    assert not canvas.wants_design({"kind": "markdown", "content": "# Notes"})


# -- the turn: asking before building -----------------------------------------


class _Scripted:
    """A model that makes the calls it is given, one round each, then answers."""

    name = "mock"
    model = "mock"

    def __init__(self, *rounds: list[tuple[str, dict]]) -> None:
        self.rounds = list(rounds)
        self.windows: list = []

    async def stream(self, messages, *, think=None, tools=None):
        self.windows.append(messages)
        if self.rounds:
            calls = self.rounds.pop(0)
            yield Chunk(
                done=True,
                tool_calls=tuple(
                    ToolCall(id=f"c{i}", name=name, arguments=args)
                    for i, (name, args) in enumerate(calls)
                ),
            )
        else:
            yield Chunk(text="Made it.", done=True)

    async def embed(self, texts):
        return [[0.0] * 8 for _ in texts]

    async def health(self):
        return True


def _orchestrator(store: Store, *rounds) -> Orchestrator:
    registry = Registry()
    for skill in (AskForDesign(store), WriteSlides(store), WriteSheet(store),
                  WriteCanvas(store), ReadCanvas(store)):
        registry.register(skill)
    provider = _Scripted(*rounds)

    async def resolve(prefer=None):
        return type("Route", (), {"provider": provider, "reason": "local"})()

    router = type("R", (), {})()
    router.resolve = resolve
    router.invalidate_health = lambda: None
    settings = type(
        "S", (),
        {
            "system_preamble": "You help.", "context_tokens": 8192,
            "reply_tokens": 1024, "ollama_think": "medium",
            "memory_max_facts": 20, "memory_fact_chars": 200,
        },
    )()
    orch = Orchestrator(settings, store, router, registry)
    orch.provider_under_test = provider
    return orch


async def _run(orch: Orchestrator, sid: str, text: str, answer: str | None = None) -> tuple[str, list]:
    frames: list[str] = []
    asked: list[dict] = []
    async for frame in orch.run_turn(sid, text):
        frames.append(frame)
        if "event: design_choice" in frame:
            payload = json.loads(frame.split("data: ", 1)[1])
            asked.append(payload)
            if answer is not None:
                orch.choices.resolve(payload["id"], answer)
    return "".join(frames), asked


DECK = ("write_slides", {"title": "Pitch", "slides": [{"title": "Hello"}]})


@pytest.mark.asyncio
async def test_building_a_deck_without_asking_asks_first(store: Store):
    orch = _orchestrator(store, [DECK])
    sid = store.create_session()["id"]
    joined, asked = await _run(orch, sid, "Make me a pitch deck", answer="swiss")

    assert len(asked) == 1 and asked[0]["before"] == "write_slides"
    # Every preset shows what it looks like, not just what it is called.
    assert all(o["swatch"] for o in asked[0]["options"] if o["source"] == "preset")
    # The pick styled the deck that was already written: no second generation.
    stored = json.loads(store.session_canvases(sid)[0].content)
    assert stored["theme"] == tokens_for("swiss")
    assert "colours and type were applied" in joined
    assert store.session_design(sid) == "swiss"


@pytest.mark.asyncio
async def test_a_custom_standard_picked_late_asks_for_a_rewrite(store: Store):
    mine = store.create_design("House", "# House\n\nNavy and cream, serif body.")
    orch = _orchestrator(store, [DECK])
    sid = store.create_session()["id"]
    joined, _ = await _run(orch, sid, "Make me a pitch deck", answer=mine.id)
    assert "Navy and cream" in joined
    assert "Call write_slides again now with the same title" in joined


@pytest.mark.asyncio
async def test_a_conversation_is_asked_once(store: Store):
    sid = store.create_session()["id"]
    orch = _orchestrator(store, [DECK])
    _, asked = await _run(orch, sid, "Deck please", answer="memo")
    assert len(asked) == 1

    # Later turns reuse the pick: the gate stays quiet, and ask_for_design
    # hands the remembered standard straight back.
    orch = _orchestrator(store, [("ask_for_design", {})], [DECK])
    joined, asked = await _run(orch, sid, "Another one")
    assert asked == []
    assert "Business memo" in joined
    stored = json.loads(store.session_canvases(sid)[0].content)
    assert stored["theme"]["accent"] == tokens_for("memo")["accent"]


@pytest.mark.asyncio
async def test_change_puts_the_list_back(store: Store):
    sid = store.create_session(design="memo")["id"]
    orch = _orchestrator(store, [("ask_for_design", {"change": True})])
    _, asked = await _run(orch, sid, "Try a different look", answer="zine")
    assert len(asked) == 1
    assert store.session_design(sid) == "zine"


@pytest.mark.asyncio
async def test_declining_is_remembered_too(store: Store):
    sid = store.create_session()["id"]
    orch = _orchestrator(store, [DECK])
    orch.choices = Choices(timeout=0.05)
    _, asked = await _run(orch, sid, "Deck")
    assert len(asked) == 1
    assert store.session_design(sid) == "none"

    orch = _orchestrator(store, [DECK])
    _, asked = await _run(orch, sid, "Another deck")
    assert asked == []


@pytest.mark.asyncio
async def test_code_and_prose_never_ask(store: Store):
    sid = store.create_session()["id"]
    orch = _orchestrator(
        store,
        [("write_canvas", {"title": "s", "content": "print(1)", "kind": "code"})],
        [("write_canvas", {"title": "n", "content": "# Notes"})],
    )
    _, asked = await _run(orch, sid, "Code and notes")
    assert asked == []
    assert store.session_design(sid) is None


@pytest.mark.asyncio
async def test_the_gate_respects_the_chooser_being_switched_off(store: Store):
    sid = store.create_session()["id"]
    orch = _orchestrator(store, [DECK])
    orch.registry.set_enabled("ask_for_design", False)
    _, asked = await _run(orch, sid, "Deck")
    assert asked == []
    assert len(store.session_canvases(sid)) == 1


# -- the design conversation's prompt ------------------------------------------


def test_a_design_conversation_reads_the_design_preamble(store: Store):
    orch = _orchestrator(store)
    chat = store.create_session()["id"]
    design = store.create_session(mode="design")["id"]
    assert DESIGN_PREAMBLE not in orch.build_system_prompt(chat)[0]
    assert DESIGN_PREAMBLE in orch.build_system_prompt(design)[0]


def test_the_chosen_standard_rides_in_the_prompt(store: Store):
    orch = _orchestrator(store)
    design = store.create_session(mode="design", design="swiss")["id"]
    chat = store.create_session(design="swiss")["id"]
    declined = store.create_session(design="none")["id"]

    full = orch.build_system_prompt(design)[0]
    assert "Order before ornament" in full and "#E3000F" in full
    # An ordinary chat gets the name, not the whole document.
    brief = orch.build_system_prompt(chat)[0]
    assert "'Swiss'" in brief and "Order before ornament" not in brief
    assert "no design standard" in orch.build_system_prompt(declined)[0]


# -- HTTP ---------------------------------------------------------------------


def test_sessions_carry_their_mode_and_standard(client: TestClient):
    made = client.post("/api/sessions", json={"mode": "design", "design": "zine"}).json()
    assert made["mode"] == "design" and made["design"] == "zine"
    plain = client.post("/api/sessions", json={}).json()
    assert plain["mode"] == "chat" and plain["design"] is None
    odd = client.post("/api/sessions", json={"mode": "banana"}).json()
    assert odd["mode"] == "chat"
    assert client.post("/api/sessions", json={"design": "nope"}).status_code == 404

    listed = {s["id"]: s for s in client.get("/api/sessions").json()["sessions"]}
    assert listed[made["id"]]["mode"] == "design"
    assert listed[made["id"]]["design"] == "zine"


def test_a_conversations_standard_can_be_changed_and_forgotten(client: TestClient):
    sid = client.post("/api/sessions", json={}).json()["id"]
    url = f"/api/sessions/{sid}/design"
    assert client.put(url, json={"design": "swiss"}).json()["design"] == "swiss"
    assert client.put(url, json={"design": "none"}).json()["design"] == "none"
    assert client.put(url, json={"design": None}).json()["design"] is None
    assert client.put(url, json={"design": "nope"}).status_code == 404
    assert client.put("/api/sessions/nope/design", json={"design": "swiss"}).status_code == 404
    assert client.get(f"/api/sessions/{sid}").json()["session"]["design"] is None


def test_presets_ship_their_tokens(client: TestClient):
    presets = client.get("/api/designs/presets").json()["presets"]
    assert all(p["tokens"]["accent"] for p in presets)


def test_the_work_tools_are_registered(client: TestClient):
    names = {s["name"] for s in client.get("/api/skills").json()["skills"]}
    assert {"write_slides", "write_sheet", "edit_sheet"} <= names


# -- arguments as models actually send them -------------------------------------
#
# The bug: a model passed `"title": {"title": "Aesthetic Summary"}` and the deck
# showed `{'title': 'Aesthetic Summary'}` in 60px type. Every tool that writes
# something the reader sees has to read wrapped text as the text it wraps.


def test_plain_text_unwraps_what_models_send():
    from app.skills.args import plain_text

    assert plain_text({"title": "Aesthetic Summary"}) == "Aesthetic Summary"
    assert plain_text("{'title': 'Aesthetic Summary'}") == "Aesthetic Summary"
    assert plain_text('{"text": "Hi"}') == "Hi"
    assert plain_text(["a", {"label": "b"}]) == "a\nb"
    assert plain_text(12.5) == "12.5"
    assert plain_text("just {braces} inside") == "just {braces} inside"
    assert plain_text(None) == ""


def test_a_deck_with_wrapped_fields_stores_the_words():
    deck = normalize_deck([
        {"layout": "bullets", "title": {"title": "Aesthetic Summary"},
         "bullets": [{"title": "Colour", "text": "Fluoro pink"}, "{'text': 'Layout'}"]},
        {"content": {"heading": "Overview", "points": ["a", "b"]}},
        "{'title': 'Nightlife', 'bullets': ['Jazz bars']}",
        {"layout": "stat", "title": ["Numbers"], "stats": '[{"value": 12, "label": {"text": "km"}}]'},
        {"layout": "two_column", "title": "x", "left": ["one", "two"], "right": {"text": "r"}},
    ])
    slides = deck["slides"]
    assert slides[0]["title"] == "Aesthetic Summary"
    assert slides[0]["bullets"] == ["Colour: Fluoro pink", "Layout"]
    assert slides[1]["title"] == "Overview" and slides[1]["bullets"] == ["a", "b"]
    assert slides[2]["title"] == "Nightlife" and slides[2]["bullets"] == ["Jazz bars"]
    assert slides[3]["title"] == "Numbers"
    assert slides[3]["stats"] == [{"value": "12", "label": "km"}]
    assert slides[4]["left"] == "- one\n- two" and slides[4]["right"] == "r"
    # Nothing anywhere carries a printed dict.
    assert "{'" not in json.dumps(deck) and '{\\"' not in json.dumps(deck)


@pytest.mark.asyncio
async def test_tools_survive_a_missing_or_wrapped_title(store: Store):
    sid = store.create_session()["id"]
    said = await WriteSlides(store).use(session=sid, slides=[{"title": "Opening"}])
    assert "'Opening'" in said
    said = await WriteSheet(store).use(
        session=sid, title={"title": "Budget"},
        columns=[{"name": "Item"}, {"name": "Cost"}],
        rows=[[{"value": "Rent"}, {"value": 1200}], ["{'text': 'Food'}", "300"]],
        formats=["text", {"format": "currency"}],
    )
    assert "'Budget'" in said
    sheet = json.loads(store.find_canvas_by_title(sid, "Budget").content)
    assert sheet["columns"] == ["Item", "Cost"]
    assert sheet["rows"] == [["Rent", 1200], ["Food", 300]]
    assert sheet["formats"] == ["text", "currency"]

    # No title, one sheet: that one.
    assert "Edited" in await EditSheet(store).use(session=sid, cells='{"B3": {"value": 5}}')
    assert json.loads(store.find_canvas_by_title(sid, "Budget").content)["rows"][1][1] == 5

    # write_canvas keeps its contract -- no title, no canvas -- but says so
    # instead of failing on a missing argument.
    assert "title" in (await WriteCanvas(store).use(session=sid, content="x")).lower()
    said = await WriteCanvas(store).use(
        session=sid, title={"title": "Notes"}, content={"text": "# Notes"}, kind={"value": "markdown"},
    )
    assert "'Notes'" in said
    assert store.find_canvas_by_title(sid, "Notes").content == "# Notes"
    assert "# Notes" in await ReadCanvas(store).use(session=sid, title={"title": "Notes"})


@pytest.mark.asyncio
async def test_a_wrapped_standard_name_still_matches(store: Store):
    orch = _orchestrator(store, [("ask_for_design", {"name": {"name": "Zine"}})])
    sid = store.create_session()["id"]
    _, asked = await _run(orch, sid, "Use the zine one")
    assert asked == []
    assert store.session_design(sid) == "zine"
