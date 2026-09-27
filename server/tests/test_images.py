"""The image library: cleaning on the way in, ids on the way out."""

from __future__ import annotations

import base64
import io
import json
import struct
import zlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings
from app.db import Database
from app.images import MAX_SIDE, ImageError, prepare, sync_from_chat
from app.main import create_app
from app.skills.canvas import WriteCanvas
from app.skills.images import ListImages
from app.skills.slides import WriteSlides, normalize_deck
from app.store import Store


@pytest.fixture
def store(tmp_path: Path) -> Store:
    return Store(Database(tmp_path / "images.db"))


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    settings = Settings(db_path=tmp_path / "images_api.db", auth_token="t")
    return TestClient(create_app(settings), headers={"Authorization": "Bearer t"})


def _jpeg_with_gps(size=(40, 20), orientation=None) -> bytes:
    image = Image.new("RGB", size, (200, 30, 30))
    exif = Image.Exif()
    exif[0x010F] = "SnoopCam"                       # Make
    exif[0x8825] = {1: "N", 2: (51.0, 30.0, 0.0)}  # GPSInfo
    if orientation:
        exif[0x0112] = orientation
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", exif=exif)
    return buffer.getvalue()


def _png(size=(10, 10), mode="RGB") -> bytes:
    buffer = io.BytesIO()
    Image.new(mode, size).save(buffer, format="PNG")
    return buffer.getvalue()


# -- cleaning -------------------------------------------------------------------


def test_metadata_is_stripped_and_orientation_applied():
    raw = _jpeg_with_gps(orientation=6)  # "rotate 90° to display"
    assert Image.open(io.BytesIO(raw)).getexif()  # the fixture really has it
    ready = prepare("holiday.jpeg", raw)
    out = Image.open(io.BytesIO(ready.data))
    assert not out.getexif(), "no EXIF -- and so no GPS -- survives"
    assert (ready.width, ready.height) == (20, 40), "rotated into the pixels"
    assert ready.mime == "image/jpeg" and ready.name == "holiday.jpg"


def test_large_images_are_scaled_and_transparency_kept():
    ready = prepare("big.png", _png((5000, 2500)))
    assert max(ready.width, ready.height) == MAX_SIDE
    assert ready.mime == "image/jpeg"
    ready = prepare("logo.png", _png((30, 30), "RGBA"))
    assert ready.mime == "image/png"


def test_what_is_not_an_image_is_refused():
    with pytest.raises(ImageError):
        prepare("x.png", b"not an image")
    with pytest.raises(ImageError):
        prepare("x.svg", b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    with pytest.raises(ImageError):
        prepare("empty.png", b"")


def test_a_decompression_bomb_is_refused_from_its_header():
    # A tiny PNG whose header claims 100k × 100k pixels.
    raw = bytearray(_png((1, 1)))
    ihdr = struct.pack(">II", 100_000, 100_000) + bytes(raw[24:29])
    raw[16:29] = ihdr
    raw[29:33] = struct.pack(">I", zlib.crc32(b"IHDR" + ihdr) & 0xFFFFFFFF)
    with pytest.raises(ImageError, match="too large"):
        prepare("bomb.png", bytes(raw))


# -- the library ------------------------------------------------------------------


def test_chat_attachments_are_imported_once_and_cleaned(store: Store):
    sid = store.create_session()["id"]
    message = store.add_message(sid, "user", "here")
    store.add_attachment(message.id, kind="image", name="p.jpg", mime="image/jpeg",
                         data=_jpeg_with_gps(), text=None)
    store.add_attachment(message.id, kind="text", name="n.txt", mime="text/plain",
                         data=b"hi", text=None)
    assert sync_from_chat(store, sid) == 1
    assert sync_from_chat(store, sid) == 0
    [image] = store.session_images(sid)
    data = store.get_image(image.id, with_data=True).data
    assert not Image.open(io.BytesIO(data)).getexif()


@pytest.mark.asyncio
async def test_list_images_names_ids_not_pixels(store: Store):
    sid = store.create_session()["id"]
    assert "no images" in (await ListImages(store).use(session=sid)).lower()
    ready = prepare("cafe.jpg", _jpeg_with_gps((60, 30)))
    image = store.add_image(sid, name=ready.name, mime=ready.mime, width=ready.width,
                            height=ready.height, data=ready.data, alt="A café at dusk")
    said = await ListImages(store).use(session=sid)
    assert image.id in said and "landscape" in said and "A café at dusk" in said
    assert len(said) < 600


@pytest.mark.asyncio
async def test_slides_keep_real_images_and_drop_invented_ones(store: Store):
    sid = store.create_session()["id"]
    ready = prepare("a.jpg", _jpeg_with_gps())
    real = store.add_image(sid, name=ready.name, mime=ready.mime, width=ready.width,
                           height=ready.height, data=ready.data)
    said = await WriteSlides(store).use(session=sid, title="Trip", slides=[
        {"layout": "photo", "title": "Shanghai", "image": real.id},
        {"layout": "split", "title": "Food", "image": {"id": "img_madeup", "fit": "contain"},
         "bullets": ["Dumplings"]},
        {"title": "Web", "image": "https://example.com/a.jpg"},
    ])
    assert "img_madeup" in said and "list_images" in said
    slides = json.loads(store.find_canvas_by_title(sid, "Trip").content)["slides"]
    assert slides[0]["image"] == {"id": real.id, "fit": "cover"}
    assert "image" not in slides[1]
    assert "image" not in slides[2], "a web address is never stored"


def test_image_layouts_are_inferred_and_aliased():
    deck = normalize_deck([
        {"title": "A", "image": "img_x1"},
        {"title": "B", "image": "img_x2", "bullets": ["one"]},
        {"layout": "full_bleed", "title": "C", "image": {"id": "img_x3", "side": "right", "alt": "sea"}},
        # "split" is its own layout, not an alias for two text columns.
        {"layout": "split", "title": "D", "image": "img_x4", "bullets": ["one"]},
    ])
    assert [s["layout"] for s in deck["slides"]] == ["photo", "split", "photo", "split"]
    assert deck["slides"][2]["image"] == {"id": "img_x3", "fit": "cover", "side": "right", "alt": "sea"}


@pytest.mark.asyncio
async def test_a_page_naming_a_missing_image_is_warned(store: Store):
    sid = store.create_session()["id"]
    said = await WriteCanvas(store).use(
        session=sid, title="Page", kind="html",
        content='<html><body><img src="bom-image:img_nope" alt=""></body></html>',
    )
    assert "img_nope" in said and "list_images" in said


# -- HTTP ---------------------------------------------------------------------------


def test_image_rest_lifecycle(client: TestClient):
    sid = client.post("/api/sessions", json={}).json()["id"]
    body = {"name": "p.jpg", "data": base64.b64encode(_jpeg_with_gps()).decode(), "alt": "Red"}
    made = client.post(f"/api/sessions/{sid}/images", json=body)
    assert made.status_code == 200
    image = made.json()
    assert image["alt"] == "Red" and image["mime"] == "image/jpeg"

    listed = client.get(f"/api/sessions/{sid}/images").json()["images"]
    assert [i["id"] for i in listed] == [image["id"]]

    got = client.get(f"/api/images/{image['id']}")
    assert got.headers["content-type"] == "image/jpeg"
    assert got.headers["x-content-type-options"] == "nosniff"
    assert not Image.open(io.BytesIO(got.content)).getexif()

    assert client.patch(f"/api/images/{image['id']}", json={"alt": "Crimson"}).json()["alt"] == "Crimson"
    assert client.delete(f"/api/images/{image['id']}").status_code == 200
    assert client.get(f"/api/images/{image['id']}").status_code == 404


def test_bad_uploads_are_400s(client: TestClient):
    sid = client.post("/api/sessions", json={}).json()["id"]
    url = f"/api/sessions/{sid}/images"
    assert client.post(url, json={"name": "x.png", "data": "!!!"}).status_code == 400
    assert client.post(url, json={"name": "x.png", "data": base64.b64encode(b"nope").decode()}).status_code == 400
    assert client.post("/api/sessions/nope/images", json={"name": "x", "data": ""}).status_code == 404


def test_deleting_the_conversation_deletes_its_images(client: TestClient):
    sid = client.post("/api/sessions", json={}).json()["id"]
    body = {"name": "p.png", "data": base64.b64encode(_png()).decode()}
    image = client.post(f"/api/sessions/{sid}/images", json=body).json()
    client.delete(f"/api/sessions/{sid}")
    assert client.get(f"/api/images/{image['id']}").status_code == 404
