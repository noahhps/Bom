"""Revising design work in place, reading it back, checking it, and the budget
that decides how much of it a model can hold."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app import design_check
from app.config import Settings
from app.db import Database
from app.design_mode import blocked_by, pinned
from app.main import create_app
from app.orchestrator import Orchestrator, clip_result
from app.providers.base import Chunk, ToolCall
from app.providers.ollama import OllamaProvider, trained_context
from app.providers.router import ProviderRouter
from app.skills.canvas import CheckDesign, EditCanvas, ReadCanvas, WriteCanvas
from app.skills.patch import apply_edits, parse_edits, set_css_variables
from app.skills.registry import Registry
from app.skills.slides import EditSlides, WriteSlides, apply_slide_ops, normalize_deck
from app.skills.wireframe import EditWireframe, WriteWireframe, apply_ops, normalize_wireframe
from app.store import Store


@pytest.fixture
def store(tmp_path: Path) -> Store:
    return Store(Database(tmp_path / "edits.db"))


PAGE = """<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width">
<style>
:root {
  --bg: #ffffff;
  --text: #1a1a1a;
  --accent: #E3000F;
}
body { background: var(--bg); color: var(--text); font-family: Georgia, serif; }
</style>
</head>
<body>
  <header>
    <h1>Harbour Coffee</h1>
  </header>
  <main>
    <section class="hero">
      <p>Roasted on the quay since 1998.</p>
      <a class="cta" href="#menu">See the menu</a>
    </section>
    <section id="menu">
      <h2>Menu</h2>
      <p>Espresso, flat white, filter.</p>
    </section>
  </main>
</body>
</html>
"""


# -- the patch engine ----------------------------------------------------------


def test_an_exact_unique_find_is_replaced():
    edits, problems = parse_edits([{"find": "Harbour Coffee", "replace": "Quay Coffee"}])
    patched = apply_edits(PAGE, edits)
    assert not problems and not patched.failed
    assert "<h1>Quay Coffee</h1>" in patched.text
    assert patched.text.count("\n") == PAGE.count("\n"), "nothing else moved"


def test_an_ambiguous_find_is_refused_with_the_count_unless_all():
    edits, _ = parse_edits([{"find": "<section", "replace": "<section data-x"}])
    patched = apply_edits(PAGE, edits)
    assert patched.text == PAGE
    assert "occurs 2 times" in patched.failed[0]

    edits, _ = parse_edits([{"find": "<section", "replace": "<section data-x", "all": True}])
    patched = apply_edits(PAGE, edits)
    assert patched.text.count("<section data-x") == 2
    assert "(2 places)" in patched.applied[0]


def test_a_find_that_differs_only_in_whitespace_still_matches():
    # Re-indented and joined onto one line, the way a model quotes it back.
    edits, _ = parse_edits([{
        "find": '<section class="hero"> <p>Roasted on the quay since 1998.</p>',
        "replace": '<section class="hero">\n      <p>Roasted on the quay since 1996.</p>',
    }])
    patched = apply_edits(PAGE, edits)
    assert "since 1996" in patched.text and not patched.failed
    assert "ignoring whitespace" in patched.applied[0]


def test_a_miss_quotes_the_closest_text():
    edits, _ = parse_edits([{"find": "<p>Roasted on the harbour since 1998.</p>", "replace": "x"}])
    patched = apply_edits(PAGE, edits)
    assert patched.text == PAGE
    assert "nothing matches" in patched.failed[0]
    assert "Roasted on the quay since 1998." in patched.failed[0]


def test_insertions_and_deletions_keep_their_anchor():
    edits, _ = parse_edits([
        {"after": "<h2>Menu</h2>", "insert": "\n      <p>Oat milk is free.</p>"},
        {"before": "<header>", "insert": "<nav>Home</nav>\n  "},
        {"delete": '\n      <a class="cta" href="#menu">See the menu</a>'},
    ])
    patched = apply_edits(PAGE, edits)
    assert not patched.failed
    assert "<h2>Menu</h2>\n      <p>Oat milk is free.</p>" in patched.text
    assert "<nav>Home</nav>\n  <header>" in patched.text
    assert "See the menu" not in patched.text


def test_edits_arrive_in_every_shape_models_send():
    as_text = json.dumps([{"old_string": "a", "new_string": "b"}])
    for shape, extra in (
        ([{"find": "a", "replace": "b"}], {}),
        ({"find": "a", "replace": "b"}, {}),
        ({"edits": [{"search": "a", "with": "b"}]}, {}),
        (as_text, {}),
        (None, {"find": "a", "replace": "b"}),
    ):
        parsed, problems = parse_edits(shape, extra)
        assert len(parsed) == 1 and parsed[0].find == "a" and parsed[0].replace == "b", shape
        assert not problems


def test_css_variables_are_set_in_root_and_added_when_missing():
    html, changed = set_css_variables(PAGE, {"--accent": "#0B5FFF", "radius": "12px"})
    assert "--accent: #0B5FFF;" in html
    assert "--radius: 12px;" in html
    assert len(changed) == 2

    bare, _ = set_css_variables("<html><head></head><body>x</body></html>", {"--bg": "#000"})
    assert "<style>" in bare and ":root" in bare and "--bg: #000" in bare


def test_css_variables_prefer_root_over_a_dark_redeclaration():
    page = (
        "<style>:root { --bg: #fff; }\n"
        "@media (prefers-color-scheme: dark) { :root { --bg: #000; } }</style>"
    )
    html, _ = set_css_variables(page, {"--bg": "#fafafa"})
    assert ":root { --bg: #fafafa; }" in html and "--bg: #000" in html


# -- edit_canvas and read_canvas -----------------------------------------------


@pytest.mark.asyncio
async def test_edit_canvas_changes_only_what_it_names(store: Store):
    sid = store.create_session()["id"]
    await WriteCanvas(store).use(session=sid, title="Site", content=PAGE, kind="html")
    said = await EditCanvas(store).use(
        session=sid,
        title="Site",
        edits=[
            {"find": "<h1>Harbour Coffee</h1>", "replace": "<h1>Quay Coffee</h1>"},
            {"find": "not in the page at all", "replace": "x"},
        ],
        css_vars={"--accent": "#0B5FFF"},
    )
    body = store.find_canvas_by_title(sid, "Site").content
    assert "<h1>Quay Coffee</h1>" in body and "--accent: #0B5FFF" in body
    assert "Menu" in body and "Espresso" in body
    assert "Edited the canvas 'Site': 2 changes" in said
    assert "Not applied" in said and "nothing matches" in said


@pytest.mark.asyncio
async def test_edit_canvas_says_when_an_edit_broke_the_markup(store: Store):
    sid = store.create_session()["id"]
    await WriteCanvas(store).use(session=sid, title="Site", content=PAGE, kind="html")
    said = await EditCanvas(store).use(
        session=sid, title="Site", edits=[{"delete": "  </main>\n"}],
    )
    assert "left the markup unbalanced" in said
    assert "unclosed <main>" in said


@pytest.mark.asyncio
async def test_edit_canvas_sends_structured_kinds_to_their_own_tool(store: Store):
    sid = store.create_session()["id"]
    await WriteSlides(store).use(session=sid, title="Pitch", slides=[{"title": "Hi"}])
    said = await EditCanvas(store).use(session=sid, title="Pitch", edits=[{"find": "Hi", "replace": "Yo"}])
    assert "edit_slides" in said


@pytest.mark.asyncio
async def test_nothing_changed_is_said_plainly(store: Store):
    sid = store.create_session()["id"]
    await WriteCanvas(store).use(session=sid, title="Notes", content="# Notes\n\nOne.")
    before = store.find_canvas_by_title(sid, "Notes").updated_at
    said = await EditCanvas(store).use(session=sid, title="Notes", edits=[{"find": "Two", "replace": "3"}])
    assert said.startswith("Nothing changed in 'Notes'")
    assert store.find_canvas_by_title(sid, "Notes").updated_at == before


@pytest.mark.asyncio
async def test_read_canvas_returns_a_whole_page_and_pages_a_long_one(store: Store):
    sid = store.create_session()["id"]
    await WriteCanvas(store).use(session=sid, title="Site", content=PAGE, kind="html")
    whole = await ReadCanvas(store).use(session=sid, title="Site")
    assert PAGE.strip() in whole, "exactly as stored, so a find copied from it matches"

    long = "\n".join(f"line {n}" for n in range(1, 2001))
    await WriteCanvas(store).use(session=sid, title="Log", content=long)
    reader = ReadCanvas(store, max_chars=1000)
    first = await reader.use(session=sid, title="Log")
    assert "lines 1-" in first and "offset=" in first and "line 1\n" in first
    next_offset = int(first.rsplit("offset=", 1)[1].split()[0])
    second = await reader.use(session=sid, title="Log", offset=next_offset)
    assert f"line {next_offset}\n" in second
    assert reader.max_result_chars > reader.max_chars


# -- the design check -------------------------------------------------------------


def test_contrast_matches_the_wcag_figures():
    assert round(design_check.contrast("#000", "#fff"), 1) == 21.0
    assert round(design_check.contrast("#777777", "#ffffff"), 2) == 4.48
    assert design_check.contrast("#777", "transparent") is None
    assert design_check.contrast("not a colour", "#fff") is None
    # A translucent ink is judged as it lands on its ground.
    assert design_check.contrast("rgba(0,0,0,0.5)", "#fff") < design_check.contrast("#000", "#fff")


def test_a_clean_page_has_nothing_to_fix():
    findings = design_check.check_html(PAGE)
    assert not [f for f in findings if f.level == design_check.FIX]


def test_a_page_with_real_problems_is_told_what_they_are():
    page = PAGE.replace("--text: #1a1a1a;", "--text: #bbbbbb;").replace(
        "</head>",
        '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">'
        "<style>.cta { background: #E3000F; color: #ff6666; }</style></head>",
    ).replace("<p>Espresso, flat white, filter.</p>", "<p>Lorem ipsum dolor sit amet.</p>")
    fixes = [f.text for f in design_check.check_html(page) if f.level == design_check.FIX]
    joined = " | ".join(fixes)
    assert "contrast" in joined and ".cta" in joined
    assert "fonts.googleapis.com" in joined
    assert "placeholder" in joined


def test_dark_mode_blocks_do_not_confuse_the_light_check():
    page = (
        "<style>:root { --bg: #fff; --text: #111; }"
        "@media (prefers-color-scheme: dark) { :root { --bg: #111; --text: #eee; } }"
        "body { background: var(--bg); color: var(--text); }</style><p>Hi</p>"
    )
    assert not [f for f in design_check.check_html(page) if f.level == design_check.FIX]


def test_check_design_reviews_any_canvas_kind(store: Store):
    import asyncio

    sid = store.create_session()["id"]
    asyncio.run(WriteCanvas(store).use(session=sid, title="Site", content=PAGE, kind="html"))
    said = asyncio.run(CheckDesign(store).use(session=sid, title="Site"))
    assert said.startswith("Design check of 'Site' (html)")


# -- wireframes -------------------------------------------------------------------


LOGIN = {
    "name": "Login", "preset": "iphone",
    "layers": [
        {"type": "nav", "text": "Bom"},
        {"type": "h1", "text": "Welcome back"},
        {"type": "input", "placeholder": "Email"},
        {"type": "input", "placeholder": "Password"},
        {"type": "button", "text": "Sign in", "link": "Home"},
    ],
}
HOME = {"name": "Home", "preset": "iphone", "layers": [{"type": "h1", "text": "Home"}]}


def _layer(doc, layer_id):
    return next(l for f in doc["frames"] for l in f["layers"] if l["id"] == layer_id)


def test_adding_after_a_layer_makes_room_below_it():
    doc = normalize_wireframe([LOGIN, HOME])
    password, button = _layer(doc, "f1_l4"), _layer(doc, "f1_l5")
    button_y = button["y"]
    done, failed = apply_ops(doc, [
        {"op": "add", "after": "f1_l4", "layer": {"type": "text", "text": "Forgot password?"}},
    ])
    assert not failed and "added f1_l6" in done[0]
    added = _layer(doc, "f1_l6")
    assert added["y"] >= password["y"] + password["h"]
    assert _layer(doc, "f1_l5")["y"] > button_y, "the button moved down to make room"
    order = [l["id"] for l in doc["frames"][0]["layers"]]
    assert order.index("f1_l6") == order.index("f1_l4") + 1


def test_removing_a_layer_closes_the_gap_and_keeps_ids_stable():
    doc = normalize_wireframe([LOGIN, HOME])
    email = _layer(doc, "f1_l3")
    apply_ops(doc, [{"op": "remove", "layer": "f1_l3"}])
    assert _layer(doc, "f1_l4")["y"] == email["y"], "the password field took its place"
    assert {l["id"] for l in doc["frames"][0]["layers"]} == {"f1_l1", "f1_l2", "f1_l4", "f1_l5"}


def test_longer_words_grow_a_text_layer_and_push_the_stack():
    doc = normalize_wireframe([LOGIN, HOME])
    title, email = _layer(doc, "f1_l2"), _layer(doc, "f1_l3")
    email_y, title_h = email["y"], title["h"]
    done, _ = apply_ops(doc, [{
        "op": "update", "layer": "f1_l2",
        "set": {"text": "Welcome back to the assistant that lives on your own machine"},
    }])
    grown = _layer(doc, "f1_l2")
    assert grown["h"] > title_h and "taller to fit" in done[0]
    assert _layer(doc, "f1_l3")["y"] - email_y == pytest.approx(grown["h"] - title_h)
    assert not [f for f in design_check.check_wireframe(doc) if f.level == design_check.FIX]


def test_layers_can_be_named_by_their_words_but_not_ambiguously():
    doc = normalize_wireframe([LOGIN, HOME])
    done, failed = apply_ops(doc, [
        {"op": "update", "layer": "Sign in", "set": {"variant": "primary", "fill": "#0B5FFF"}},
        {"op": "update", "layer": "Welcome", "set": {"color": "#333"}},
    ])
    assert _layer(doc, "f1_l5")["fill"] == "#0B5FFF" and len(done) == 2
    both = normalize_wireframe([LOGIN, {**HOME, "layers": [{"type": "h1", "text": "Welcome home"}]}])
    _, failed = apply_ops(both, [{"op": "update", "layer": "Welcome", "set": {"color": "#333"}}])
    assert "matches 2 layers" in failed[0]


def test_null_takes_a_property_off():
    doc = normalize_wireframe([LOGIN, HOME])
    apply_ops(doc, [{"op": "update", "layer": "f1_l5", "set": {"fill": "#f00"}}])
    apply_ops(doc, [{"op": "update", "layer": "f1_l5", "set": {"fill": None}}])
    assert "fill" not in _layer(doc, "f1_l5")


def test_frames_are_added_duplicated_renamed_and_removed_with_their_links():
    doc = normalize_wireframe([LOGIN, HOME])
    done, failed = apply_ops(doc, [
        {"op": "add_frame", "frame": {"name": "Settings", "layers": [
            {"type": "h2", "text": "Settings"}, {"type": "button", "text": "Back", "link": "Home"}]}},
        {"op": "duplicate_frame", "frame": "Home", "name": "Home (empty)"},
        {"op": "update_frame", "frame": "f2", "set": {"name": "Dashboard", "fill": "#fafafa"}},
    ])
    assert not failed
    names = [f["name"] for f in doc["frames"]]
    assert names == ["Login", "Dashboard", "Settings", "Home (empty)"]
    settings = doc["frames"][2]
    assert settings["id"] == "f3" and settings["layers"][1]["link"] == "f2"
    assert settings["x"] > doc["frames"][1]["x"], "placed to the right on the board"

    apply_ops(doc, [{"op": "remove_frame", "frame": "Dashboard"}])
    assert "link" not in _layer(doc, "f1_l5"), "a link to a removed screen goes with it"


def test_align_and_distribute_tidy_a_group():
    doc = normalize_wireframe([{"name": "X", "w": 800, "h": 600, "layers": [
        {"type": "button", "text": "A", "x": 20, "y": 10, "w": 100, "h": 40},
        {"type": "button", "text": "B", "x": 23, "y": 90, "w": 100, "h": 40},
        {"type": "button", "text": "C", "x": 19, "y": 300, "w": 100, "h": 40},
    ]}])
    apply_ops(doc, [
        {"op": "align", "layers": ["f1_l1", "f1_l2", "f1_l3"], "to": "left"},
        {"op": "distribute", "layers": ["f1_l1", "f1_l2", "f1_l3"], "axis": "vertical", "gap": 16},
    ])
    layers = doc["frames"][0]["layers"]
    assert {l["x"] for l in layers} == {19}
    assert [l["y"] for l in layers] == [10, 66, 122]


def test_unknown_ops_and_layers_are_reported_not_fatal():
    doc = normalize_wireframe([LOGIN])
    done, failed = apply_ops(doc, [
        {"op": "explode"},
        {"op": "update", "layer": "f9_l9", "set": {"text": "x"}},
        {"op": "update", "layer": "f1_l2", "set": {"text": "Hi"}},
    ])
    assert len(done) == 1 and len(failed) == 2
    assert "unknown op" in failed[0] and "read_canvas" in failed[1]


def test_the_wireframe_check_finds_what_a_reviewer_would():
    doc = normalize_wireframe([{"name": "Card", "preset": "iphone", "layers": [
        {"type": "button", "text": "Way off", "x": 300, "y": 830, "w": 200, "h": 48},
        {"type": "text", "text": "Overlapping", "x": 24, "y": 100, "w": 200, "h": 30},
        {"type": "input", "text": "Here too", "x": 30, "y": 105, "w": 200, "h": 48},
        {"type": "text", "text": "A sentence far too long for the box it has been given", "x": 24,
         "y": 400, "w": 80, "h": 20},
        {"type": "text", "text": "Faint", "x": 24, "y": 500, "w": 200, "h": 24, "color": "#eeeeee"},
    ]}])
    fixes = " | ".join(f.text for f in design_check.check_wireframe(doc) if f.level == design_check.FIX)
    assert "past the right and bottom edge" in fixes
    assert "overlapping" in fixes
    assert "too long for its box" in fixes
    assert "contrast" in fixes


@pytest.mark.asyncio
async def test_edit_wireframe_saves_and_reports(store: Store):
    sid = store.create_session()["id"]
    await WriteWireframe(store).use(session=sid, title="App", frames=[LOGIN, HOME])
    said = await EditWireframe(store).use(session=sid, title="App", ops=[
        {"op": "update", "layer": "f1_l5", "set": {"text": "Log in"}},
        {"op": "nonsense"},
    ])
    doc = json.loads(store.find_canvas_by_title(sid, "App").content)
    assert _layer(doc, "f1_l5")["text"] == "Log in"
    assert "Edited the wireframe 'App'" in said and "Not applied" in said
    read = await ReadCanvas(store).use(session=sid, title="App")
    assert "f1_l5 button" in read and '"Log in"' in read


# -- decks ------------------------------------------------------------------------


def test_slide_numbers_mean_the_deck_as_it_was_read():
    deck = normalize_deck([
        {"layout": "title", "title": "One"},
        {"layout": "bullets", "title": "Two", "bullets": ["a"]},
        {"layout": "content", "title": "Three", "body": "x"},
        {"layout": "closing", "title": "Four"},
    ])
    done, failed = apply_slide_ops(deck, [
        {"op": "remove", "slide": 2},
        {"op": "update", "slide": 4, "set": {"title": "The end"}},
        {"op": "add", "after": 1, "slide": {"layout": "quote", "quote": "Q", "attribution": "A"}},
        {"op": "move", "slide": 3, "to": 1},
        {"op": "update", "slide": 2, "set": {"title": "x"}},
    ])
    assert [s.get("title") or s.get("quote") for s in deck["slides"]] == ["Three", "One", "Q", "The end"]
    assert failed == ["op 5: slide 2 was already removed"]


def test_a_slide_field_is_removed_with_null_and_the_theme_merged():
    deck = normalize_deck([{"layout": "title", "title": "T", "subtitle": "S"}], {"accent": "#E3000F"})
    apply_slide_ops(deck, [
        {"op": "update", "slide": 1, "set": {"subtitle": None, "notes": "Say hello"}},
        {"op": "theme", "set": {"background": "#fffaf0"}},
        {"op": "duplicate", "slide": 1},
    ])
    first = deck["slides"][0]
    assert "subtitle" not in first and first["notes"] == "Say hello"
    assert deck["theme"]["accent"] == "#E3000F" and deck["theme"]["background"] == "#fffaf0"
    assert len(deck["slides"]) == 2


@pytest.mark.asyncio
async def test_edit_slides_saves_and_reports(store: Store):
    sid = store.create_session()["id"]
    await WriteSlides(store).use(session=sid, title="Pitch", slides=[
        {"layout": "title", "title": "Bom"}, {"layout": "bullets", "title": "Why", "bullets": ["a"]},
    ])
    said = await EditSlides(store).use(session=sid, title="Pitch", ops=[
        {"op": "update", "slide": 2, "set": {"bullets": ["Local", "Private"]}},
    ])
    deck = json.loads(store.find_canvas_by_title(sid, "Pitch").content)
    assert deck["slides"][1]["bullets"] == ["Local", "Private"]
    assert "Edited the deck 'Pitch', now 2 slides" in said


# -- the budget -------------------------------------------------------------------


def test_a_cut_result_says_that_it_was_cut():
    assert clip_result("short", 100) == "short"
    cut = clip_result("x" * 500, 100)
    assert cut.startswith("x" * 100) and "the result was 500 characters" in cut


def test_ollama_reads_the_trained_context_from_show():
    assert trained_context({"model_info": {"qwen3moe.context_length": 262144}}) == 262144
    assert trained_context({"model_info": {"general.architecture": "llama"}}) is None
    assert trained_context({}) is None


@pytest.mark.asyncio
async def test_ollama_never_asks_for_more_context_than_the_model_was_trained_on():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/show":
            return httpx.Response(200, json={"model_info": {"llama.context_length": 8192}})
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, text=json.dumps({"message": {"content": "hi"}, "done": True}))

    provider = OllamaProvider("http://ollama.test", "small", context_tokens=65536)
    provider._client = httpx.AsyncClient(
        base_url="http://ollama.test", transport=httpx.MockTransport(handler)
    )
    assert await provider.context_window() == 8192
    async for _ in provider.stream([]):
        pass
    assert seen["body"]["options"]["num_ctx"] == 8192

    provider.model = "big"
    provider._shown["big"] = {"context": 1_000_000}
    assert await provider.context_window() == 65536, "the configured budget still caps it"


class _Windowed:
    name = "mock"
    model = "mock"

    def __init__(self, window: int) -> None:
        self.window = window

    async def context_window(self) -> int:
        return self.window


@pytest.mark.asyncio
async def test_the_window_budget_is_the_backends_less_the_reply_and_the_shelf(store: Store):
    settings = type("S", (), {"context_tokens": 8192, "reply_tokens": 8192})()
    orch = Orchestrator(settings, store, router=None, registry=None)
    tools = [{"name": "t", "description": "d" * 4000, "parameters": {}}]
    big = await orch._window_budget(_Windowed(200_000), tools)
    assert big == 200_000 - 8192 - len(json.dumps(tools)) // 4
    # A small configured window keeps most of itself for the history.
    small = await orch._window_budget(object(), None)
    assert small == 8192 - 8192 // 4


def test_the_defaults_hold_a_page_while_revising_it():
    settings = Settings(db_path=Path("/tmp/unused.db"), auth_token="x")
    assert settings.context_tokens >= 65536
    assert settings.reply_tokens >= 8192
    assert settings.canvas_read_chars >= 40_000


def test_the_router_gives_the_cloud_its_own_window():
    settings = Settings(db_path=Path("/tmp/unused.db"), auth_token="x")
    router = ProviderRouter(settings)
    assert router.cloud.context_tokens == settings.cloud_context_tokens
    assert router.cloud.max_tokens == settings.cloud_max_tokens
    assert router.openrouter.context_tokens == settings.cloud_context_tokens
    assert router.local.context_tokens == settings.context_tokens


# -- wiring -----------------------------------------------------------------------


def test_the_make_menu_keeps_the_edit_tool_for_its_format():
    assert "edit_canvas" not in blocked_by(pinned("page"))
    assert "edit_wireframe" in blocked_by(pinned("page"))
    assert "edit_slides" not in blocked_by(pinned("slides"))
    assert "edit_canvas" in blocked_by(pinned("slides"))
    assert "check_design" not in blocked_by(pinned("wireframe"))


def test_the_server_offers_the_edit_tools(tmp_path: Path):
    app = create_app(Settings(db_path=tmp_path / "api.db", auth_token="test_token"))
    client = TestClient(app, headers={"Authorization": "Bearer test_token"})
    names = {s["name"] for s in client.get("/api/skills").json()["skills"]}
    assert {"edit_canvas", "edit_wireframe", "edit_slides", "check_design"} <= names


class _Editor:
    """A model that writes a page, then patches it."""

    name = "mock"
    model = "mock"

    def __init__(self) -> None:
        self.calls = 0
        self.seen: list[str] = []

    async def stream(self, messages, *, think=None, tools=None):
        self.calls += 1
        if self.calls > 1:
            self.seen.append(messages[-1].content)
        if self.calls == 1:
            yield Chunk(done=True, tool_calls=(ToolCall("c1", "write_canvas", {
                "title": "Site", "content": PAGE, "kind": "html"}),))
        elif self.calls == 2:
            yield Chunk(done=True, tool_calls=(ToolCall("c2", "edit_canvas", {
                "title": "Site", "edits": [{"find": "Harbour", "replace": "Quay"}]}),))
        else:
            yield Chunk(text="Renamed it.", done=True)

    async def embed(self, texts):
        return [[0.0] * 8 for _ in texts]

    async def health(self):
        return True


@pytest.mark.asyncio
async def test_a_turn_can_write_then_patch_a_page(store: Store):
    registry = Registry()
    for skill in (WriteCanvas(store), EditCanvas(store), ReadCanvas(store)):
        registry.register(skill)
    provider = _Editor()
    router = ProviderRouter.__new__(ProviderRouter)

    async def resolve(prefer=None):
        return type("Route", (), {"provider": provider, "reason": "local"})()

    router.resolve = resolve
    router.invalidate_health = lambda: None
    settings = type("S", (), {
        "system_preamble": "You help.", "context_tokens": 8192, "reply_tokens": 1024,
        "ollama_think": "medium", "memory_max_facts": 20, "memory_fact_chars": 200,
    })()
    orch = Orchestrator(settings, store, router, registry)
    sid = store.create_session()["id"]
    frames = [f async for f in orch.run_turn(sid, "Make me a coffee shop page, then rename it")]
    assert "event: done" in "".join(frames)
    body = store.find_canvas_by_title(sid, "Site").content
    assert "<h1>Quay Coffee</h1>" in body and "Espresso" in body
    assert "Edited the canvas 'Site'" in provider.seen[1]


# -- looking at the work ----------------------------------------------------------

from app.providers.anthropic import _build_turns  # noqa: E402
from app.providers.base import Image, Message  # noqa: E402
from app.providers.ollama import sees  # noqa: E402
from app.render import Renderer, find_engine, page_stage, wireframe_stage  # noqa: E402
from app.skills.skill import Pictured  # noqa: E402
from app.skills.view import ViewCanvas  # noqa: E402

PNG = b"\x89PNG\r\n\x1a\nfake"


class _FakeEngine:
    name = "fake"

    def __init__(self) -> None:
        self.pages: list[str] = []

    async def shoot(self, page, out_dir):
        self.pages.append(page.read_text())
        shot = out_dir / "shot.png"
        shot.write_bytes(PNG)
        return shot


def test_the_stage_escapes_what_it_frames():
    page = "<p style='color:red'>\"quoted\" & more</p>"
    stage = page_stage(page)
    assert 'srcdoc="&lt;p style=&#x27;color:red&#x27;&gt;&quot;quoted&quot; &amp; more' in stage
    assert 'sandbox=""' in stage, "scripts are off in the frame"
    assert "style='" not in stage, "a font stack's quotes cannot end a style attribute"
    mobile = page_stage(page, "mobile", scroll=200)
    assert mobile.count("<iframe") == 2 and "top:-200px" in mobile and "top:-1044px" in mobile


def test_a_wireframe_is_drawn_with_its_theme_and_names():
    doc = normalize_wireframe([LOGIN, HOME], "styled", {"accent": "#E3000F", "heading_font": "Georgia, serif"})
    stage = wireframe_stage(doc, doc["frames"])
    assert "f1 · Login" in stage and "f2 · Home" in stage
    assert "#E3000F" in stage and "Georgia, serif" in stage
    assert "Welcome back" in stage and "Sign in" in stage
    grey = wireframe_stage(normalize_wireframe([LOGIN]), normalize_wireframe([LOGIN])["frames"])
    assert "#1F4FD8" in grey and "DM Mono" in grey, "an unstyled wireframe wears Bom's kit"


@pytest.mark.asyncio
async def test_view_canvas_hands_back_a_picture(store: Store):
    engine = _FakeEngine()
    view = ViewCanvas(store, Renderer(engine))
    sid = store.create_session()["id"]
    await WriteCanvas(store).use(session=sid, title="Site", content=PAGE, kind="html")
    await WriteWireframe(store).use(session=sid, title="App", frames=[LOGIN, HOME])

    page = await view.use(session=sid, title="Site", device="mobile")
    assert isinstance(page, Pictured) and page.images[0].data == PNG
    assert "phone width" in page and "Harbour Coffee" in engine.pages[-1]

    screens = await view.use(session=sid, title="App", frames=["Home"])
    assert isinstance(screens, Pictured) and "f2 'Home'" in screens
    assert "f1 · Login" not in engine.pages[-1]

    await WriteSlides(store).use(session=sid, title="Deck", slides=[{"title": "Hi"}])
    said = await view.use(session=sid, title="Deck")
    assert not isinstance(said, Pictured) and "check_design" in said


def test_view_canvas_is_offered_only_where_something_can_draw(store: Store):
    assert ViewCanvas(store, Renderer(_FakeEngine())).available
    nothing = Renderer(_FakeEngine())
    nothing.engine = None
    assert not ViewCanvas(store, nothing).available


@pytest.mark.skipif(find_engine() is None, reason="no browser or Quick Look on this machine")
@pytest.mark.asyncio
async def test_a_real_engine_draws_a_png():
    png = await Renderer().draw(page_stage(PAGE))
    assert png is not None and png.startswith(b"\x89PNG")


def test_ollama_knows_a_model_that_can_see():
    assert sees({"capabilities": ["completion", "vision"]}) is True
    assert sees({"capabilities": ["completion", "tools"]}) is False
    assert sees({"model_info": {"mllama.vision.block_count": 32}}) is True
    assert sees({}) is False


def test_a_picture_after_tool_results_joins_their_turn():
    turns = _build_turns([
        Message(role="user", content="Make a page"),
        Message(role="assistant", content="", tool_calls=(ToolCall("t1", "view_canvas", {}),)),
        Message(role="tool", content="This is 'Site'.", tool_call_id="t1", tool_name="view_canvas"),
        Message(role="user", content="The picture.", images=(Image("s.png", "image/png", PNG),)),
    ])
    assert [t["role"] for t in turns] == ["user", "assistant", "user"]
    kinds = [block["type"] for block in turns[-1]["content"]]
    assert kinds == ["tool_result", "image", "text"]


class _Looker:
    """A model that writes a page, looks at it, then answers."""

    name = "mock"
    model = "mock"

    def __init__(self, sees: bool) -> None:
        self._sees = sees
        self.calls = 0
        self.windows: list[list] = []
        self.tools: list[set] = []

    async def sees_images(self) -> bool:
        return self._sees

    async def stream(self, messages, *, think=None, tools=None):
        self.calls += 1
        self.windows.append(list(messages))
        self.tools.append({t["name"] for t in tools or []})
        if self.calls == 1:
            yield Chunk(done=True, tool_calls=(ToolCall("c1", "write_canvas", {
                "title": "Site", "content": PAGE, "kind": "html"}),))
        elif self.calls == 2:
            yield Chunk(done=True, tool_calls=(ToolCall("c2", "view_canvas", {"title": "Site"}),))
        else:
            yield Chunk(text="Looks right.", done=True)

    async def embed(self, texts):
        return [[0.0] * 8 for _ in texts]

    async def health(self):
        return True


def _looking_orchestrator(store: Store, provider) -> Orchestrator:
    registry = Registry()
    for skill in (WriteCanvas(store), ViewCanvas(store, Renderer(_FakeEngine()))):
        registry.register(skill)
    router = ProviderRouter.__new__(ProviderRouter)

    async def resolve(prefer=None):
        return type("Route", (), {"provider": provider, "reason": "local"})()

    router.resolve = resolve
    router.invalidate_health = lambda: None
    settings = type("S", (), {
        "system_preamble": "You help.", "context_tokens": 8192, "reply_tokens": 1024,
        "ollama_think": "medium", "memory_max_facts": 20, "memory_fact_chars": 200,
    })()
    return Orchestrator(settings, store, router, registry)


@pytest.mark.asyncio
async def test_a_model_that_can_see_is_shown_the_render(store: Store):
    provider = _Looker(sees=True)
    orch = _looking_orchestrator(store, provider)
    sid = store.create_session()["id"]
    frames = [f async for f in orch.run_turn(sid, "Make a page and check it")]
    assert "event: done" in "".join(frames)
    last = provider.windows[2]
    assert last[-2].role == "tool" and last[-2].tool_name == "view_canvas"
    assert last[-1].role == "user" and last[-1].images[0].data == PNG
    # The picture is for that round only: nothing of it is stored.
    stored = [m for m in store.list_messages(sid) if m.role == "assistant"][-1]
    assert "PNG" not in stored.content


@pytest.mark.asyncio
async def test_a_model_that_cannot_see_is_not_offered_the_render(store: Store):
    provider = _Looker(sees=False)
    orch = _looking_orchestrator(store, provider)
    sid = store.create_session()["id"]
    frames = "".join([f async for f in orch.run_turn(sid, "Make a page and check it")])
    assert "view_canvas" not in provider.tools[0]
    # Called anyway, from habit: it runs, but the model is told it saw nothing.
    assert "could not be shown" in frames
    assert not any(m.images for window in provider.windows for m in window)


# -- the Make menu and the edit tools ---------------------------------------------


class _PinnedEditor:
    name = "mock"
    model = "mock"

    def __init__(self) -> None:
        self.calls = 0

    async def stream(self, messages, *, think=None, tools=None):
        self.calls += 1
        if self.calls == 1:
            yield Chunk(done=True, tool_calls=(ToolCall("e1", "edit_wireframe", {
                "title": "App", "ops": [{"op": "update", "layer": "f1_l5", "set": {"text": "Log in"}}]}),))
        else:
            yield Chunk(text="Changed.", done=True)

    async def embed(self, texts):
        return [[0.0] * 8 for _ in texts]

    async def health(self):
        return True


@pytest.mark.asyncio
async def test_an_edit_honours_a_pinned_format(store: Store):
    registry = Registry()
    for skill in (WriteWireframe(store), EditWireframe(store), ReadCanvas(store)):
        registry.register(skill)
    provider = _PinnedEditor()
    router = type("R", (), {})()

    async def resolve(prefer=None):
        return type("Route", (), {"provider": provider, "reason": "local"})()

    router.resolve = resolve
    router.invalidate_health = lambda: None
    settings = type("S", (), {
        "system_preamble": "You help.", "context_tokens": 8192, "reply_tokens": 1024,
        "ollama_think": "medium", "memory_max_facts": 20, "memory_fact_chars": 200,
    })()
    orch = Orchestrator(settings, store, router, registry)
    sid = store.create_session()["id"]
    await WriteWireframe(store).use(session=sid, title="App", frames=[LOGIN, HOME])
    joined = "".join([f async for f in orch.run_turn(sid, "Rename the button", make="wireframe")])
    makes = [json.loads(b.split("data: ", 1)[1]) for b in joined.split("\n\n")
             if b.startswith("event: make\n")]
    assert [m["status"] for m in makes] == ["done"], "no nudge towards a rewrite"
    assert provider.calls == 2


# -- pictures attached in the chat ------------------------------------------------

import io  # noqa: E402

from PIL import Image as PILImage  # noqa: E402

from app.attachments import IncomingFile  # noqa: E402
from app.skills.images import resolve_image  # noqa: E402


def _jpeg(colour=(30, 90, 200)) -> bytes:
    buffer = io.BytesIO()
    PILImage.new("RGB", (64, 40), colour).save(buffer, format="JPEG")
    return buffer.getvalue()


def _attach(store: Store, sid: str, name: str, colour=(30, 90, 200)) -> None:
    message = store.add_message(sid, "user", "Here is the photo.")
    store.add_attachment(message.id, kind="image", name=name, mime="image/jpeg", data=_jpeg(colour))


@pytest.mark.asyncio
async def test_a_wireframe_can_use_a_chat_picture_by_its_name(store: Store):
    sid = store.create_session()["id"]
    _attach(store, sid, "harbour-front.jpg")
    # Straight to the wireframe, never having called list_images, naming the
    # picture the way it was shown: its file name.
    said = await WriteWireframe(store).use(session=sid, title="App", frames=[{
        "name": "Home", "layers": [{"type": "image", "image": "harbour-front.jpg"}]}])
    doc = json.loads(store.find_canvas_by_title(sid, "App").content)
    image_id = store.session_images(sid)[0].id
    assert doc["frames"][0]["layers"][0]["image"] == image_id
    assert "Left off" not in said and image_id in said


@pytest.mark.asyncio
async def test_the_attached_photo_resolves_in_every_canvas_tool(store: Store):
    sid = store.create_session()["id"]
    _attach(store, sid, "cup.jpg")
    await WriteWireframe(store).use(session=sid, title="App", frames=[LOGIN])
    said = await EditWireframe(store).use(session=sid, title="App", ops=[
        {"op": "add", "frame": "Login", "after": "f1_l2", "layer": {"type": "image", "image": "the attached photo"}},
    ])
    doc = json.loads(store.find_canvas_by_title(sid, "App").content)
    image_id = store.session_images(sid)[0].id
    assert any(l.get("image") == image_id for l in doc["frames"][0]["layers"]), said

    await WriteSlides(store).use(session=sid, title="Deck", slides=[
        {"layout": "photo", "title": "Cup", "image": "cup.jpg"}])
    deck = json.loads(store.find_canvas_by_title(sid, "Deck").content)
    assert deck["slides"][0]["image"]["id"] == image_id

    said = await WriteCanvas(store).use(session=sid, title="Page", kind="html",
                                        content='<img src="bom-image:cup.jpg" alt="A cup">')
    assert f"bom-image:{image_id}" in store.find_canvas_by_title(sid, "Page").content
    assert "WARNING" not in said


def test_references_resolve_by_name_order_and_intent():
    class Pic:
        def __init__(self, id, name):
            self.id, self.name = id, name

    two = [Pic("img_a1", "harbour.jpg"), Pic("img_b2", "Espresso cup.png")]
    assert resolve_image(two, "espresso cup") == "img_b2"
    assert resolve_image(two, "image 2") == "img_b2"
    assert resolve_image(two, "the attached image") == "img_b2", "the latest one"
    assert resolve_image(two, "first") == "img_a1"
    assert resolve_image(two, "hero.jpg") is None, "two pictures, and the name fits neither"
    assert resolve_image([two[0]], "hero.jpg") == "img_a1", "one picture can only mean that one"
    assert resolve_image(two, "https://example.com/a.jpg") is None
    assert resolve_image(two, "placeholder") is None


class _SeesAttachment:
    name = "mock"
    model = "mock"

    def __init__(self) -> None:
        self.windows: list[list] = []

    async def stream(self, messages, *, think=None, tools=None):
        self.windows.append(list(messages))
        yield Chunk(text="Got it.", done=True)

    async def embed(self, texts):
        return [[0.0] * 8 for _ in texts]

    async def health(self):
        return True


@pytest.mark.asyncio
async def test_an_attached_picture_is_in_the_library_and_its_id_beside_it(store: Store):
    provider = _SeesAttachment()
    router = ProviderRouter.__new__(ProviderRouter)

    async def resolve(prefer=None):
        return type("Route", (), {"provider": provider, "reason": "local"})()

    router.resolve = resolve
    router.invalidate_health = lambda: None
    settings = type("S", (), {
        "system_preamble": "You help.", "context_tokens": 8192, "reply_tokens": 1024,
        "ollama_think": "medium", "memory_max_facts": 20, "memory_fact_chars": 200,
    })()
    orch = Orchestrator(settings, store, router, Registry())
    sid = store.create_session()["id"]
    upload = IncomingFile(kind="image", name="storefront.jpg", mime="image/jpeg", data=_jpeg())
    [f async for f in orch.run_turn(sid, "Put this in the wireframe", attached=[upload])]

    images = store.session_images(sid)
    assert len(images) == 1 and images[0].name.startswith("storefront")
    user_turn = provider.windows[0][-1]
    assert f"storefront.jpg is {images[0].id}" in user_turn.content
    assert user_turn.images, "and the picture itself still travels for a model that can see"
