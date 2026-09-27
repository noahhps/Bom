"""Wireframes: the document, the flow pass, the tools, opening canvases."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.db import Database
from app.main import create_app
from app.skills.canvas import OpenCanvas, ReadCanvas
from app.skills.slides import normalize_deck
from app.skills.wireframe import (
    WireframeToSlides,
    WriteWireframe,
    normalize_wireframe,
    to_slides,
)
from app.store import Store


@pytest.fixture
def store(tmp_path: Path) -> Store:
    return Store(Database(tmp_path / "wf.db"))


LOGIN = {
    "name": "Login",
    "preset": "iphone",
    "layers": [
        {"type": "nav", "text": "Bom", "items": ["Help"]},
        {"type": "h1", "text": "Welcome back"},
        {"type": "input", "placeholder": "Email"},
        {"type": "button", "text": "Sign in", "link": "Home"},
        {"type": "row", "children": [{"type": "button", "text": "A"}, {"type": "button", "text": "B"}]},
    ],
}


def test_flow_places_layers_that_have_no_position():
    doc = normalize_wireframe([LOGIN, {"name": "Home", "preset": "desktop", "layers": []}])
    login, home = doc["frames"]
    assert (login["w"], login["h"]) == (393, 852) and (home["w"], home["h"]) == (1440, 1024)
    nav, title, email, button, a, b = login["layers"]
    assert (nav["x"], nav["y"], nav["w"]) == (0, 0, 393), "a nav sits flush at the top"
    assert title["font"] == "heading" and title["size"] == 36
    assert email["y"] > title["y"] + title["h"] - 1, "stacked, not overlapping"
    assert button["w"] == 393 - 48, "full width on a phone"
    assert a["y"] == b["y"] and b["x"] > a["x"] and a["w"] == b["w"], "a row splits the width"
    assert button["link"] == home["id"], "links resolve from a frame name to its id"
    assert home["x"] >= login["x"] + login["w"], "frames laid out side by side on the board"
    assert len({l["id"] for l in login["layers"]}) == len(login["layers"])


def test_explicit_geometry_wins_and_junk_is_dropped():
    doc = normalize_wireframe([{
        "name": "X", "w": 800, "h": 600,
        "layers": [
            {"type": "rectangle", "x": 10, "y": 20, "w": 30, "h": 40, "fill": "red; x:y", "radius": 9999},
            {"type": "photo", "image": "https://example.com/a.png"},
            {"type": "button", "text": {"text": "Go"}, "link": "Nowhere"},
        ],
    }])
    rect, image, button = doc["frames"][0]["layers"]
    assert (rect["type"], rect["x"], rect["y"], rect["w"], rect["h"]) == ("rect", 10, 20, 30, 40)
    assert "fill" not in rect and rect["radius"] == 999
    assert image["type"] == "image" and "image" not in image, "never a web address"
    assert button["text"] == "Go" and "link" not in button


def test_fidelity_and_theme():
    styled = normalize_wireframe([LOGIN], "styled", {"accent": "#FF0000"})
    assert styled["fidelity"] == "styled" and styled["theme"] == {"accent": "#FF0000"}
    assert normalize_wireframe([LOGIN])["fidelity"] == "wireframe"


def test_slides_carry_each_frame_as_a_board():
    doc = normalize_wireframe([LOGIN, {"name": "Home", "layers": []}])
    deck = normalize_deck(to_slides(doc)["slides"])
    assert [s["layout"] for s in deck["slides"]] == ["board", "board"]
    assert deck["slides"][0]["title"] == "Login"
    assert deck["slides"][0]["board"]["frame"]["layers"][0]["type"] == "nav"


@pytest.mark.asyncio
async def test_the_tools(store: Store):
    sid = store.create_session()["id"]
    said = await WriteWireframe(store).use(session=sid, title="Onboarding", frames=[LOGIN])
    assert "1 frame" in said
    canvas = store.find_canvas_by_title(sid, "Onboarding")
    assert canvas.kind == "wireframe"
    read = await ReadCanvas(store).use(session=sid, title="Onboarding")
    assert 'frame f1 "Login" 393×852' in read and '"Sign in"' in read

    said = await WireframeToSlides(store).use(session=sid, title="Onboarding")
    assert "1 slides" in said or "1 slide" in said
    deck = store.find_canvas_by_title(sid, "Onboarding — deck")
    assert deck.kind == "slides"
    assert json.loads(deck.content)["slides"][0]["layout"] == "board"

    assert WriteWireframe(store).wants_design({"fidelity": "styled"})
    assert not WriteWireframe(store).wants_design({})


@pytest.mark.asyncio
async def test_open_canvas_here_and_from_elsewhere(store: Store):
    here = store.create_session(title="Now")["id"]
    there = store.create_session(title="Last week")["id"]
    older = store.create_canvas(here, "Notes", content="hi")
    store.create_canvas(here, "Newer", content="x")
    said = await OpenCanvas(store).use(session=here, title="notes")
    assert "Opened 'Notes'" in said
    assert store.session_canvases(here)[0].id == older.id, "brought to the front"

    store.add_image(there, name="a.png", mime="image/png", width=1, height=1, data=b"x")
    image = store.session_images(there)[0]
    store.create_canvas(there, "Pitch", content=json.dumps({"slides": [{"image": {"id": image.id}}]}),
                        kind="slides")
    said = await OpenCanvas(store).use(session=here, title="pitch")
    assert "copy of 'Pitch'" in said and "Last week" in said
    copy = store.find_canvas_by_title(here, "Pitch")
    assert copy.kind == "slides"
    copied_image = store.session_images(here)[0]
    assert copied_image.id in copy.content and image.id not in copy.content, "pictures come along"

    listing = await OpenCanvas(store).use(session=here)
    assert "Pitch (slides) in this conversation" in listing and '"Last week"' in listing
    assert "no canvas called" in await OpenCanvas(store).use(session=here, title="nope")


def test_canvas_routes(tmp_path: Path):
    client = TestClient(create_app(Settings(db_path=tmp_path / "r.db", auth_token="t")),
                        headers={"Authorization": "Bearer t"})
    a = client.post("/api/sessions", json={}).json()["id"]
    b = client.post("/api/sessions", json={}).json()["id"]
    made = client.post(f"/api/sessions/{a}/canvases", json={"title": "Plan", "content": "x"}).json()
    listed = client.get("/api/canvases").json()["canvases"]
    assert listed[0]["id"] == made["id"] and "content" not in listed[0]
    copy = client.post(f"/api/canvases/{made['id']}/copy", json={"session_id": b})
    assert copy.status_code == 200 and copy.json()["session_id"] == b
    assert client.post("/api/canvases/nope/copy", json={"session_id": b}).status_code == 404
