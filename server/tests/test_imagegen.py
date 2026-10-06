"""Generating pictures: the two backends, the guards, and where prompts go."""

from __future__ import annotations

import base64
import io
import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings
from app.db import Database
from app.imagegen import Generator, GenerationError, check_prompt, create, styled_prompt
from app.main import create_app
from app.orchestrator import Orchestrator
from app.providers.base import Chunk, ToolCall
from app.skills.images import GenerateImage, ListImages
from app.skills.registry import Registry
from app.skills.slides import WriteSlides
from app.store import Store


def _png_b64(size=(64, 40)) -> str:
    buffer = io.BytesIO()
    Image.new("RGB", size, (30, 120, 200)).save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode()


class Recorder:
    """A fake generator: records what it was sent, answers with a picture."""

    def __init__(self, answer=None, status=200):
        self.requests: list[httpx.Request] = []
        self.answer = answer
        self.status = status

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.answer is not None:
            return httpx.Response(self.status, json=self.answer)
        if request.url.path.endswith("/sdapi/v1/txt2img"):
            return httpx.Response(200, json={"images": [_png_b64()]})
        return httpx.Response(200, json={"data": [{"b64_json": _png_b64()}]})

    @property
    def last(self) -> dict:
        return json.loads(self.requests[-1].content)


def _generator(url="http://127.0.0.1:7860", backend="a1111", recorder=None, **kw):
    recorder = recorder or Recorder()
    return Generator(url, backend=backend, transport=httpx.MockTransport(recorder), **kw), recorder


@pytest.fixture
def store(tmp_path: Path) -> Store:
    return Store(Database(tmp_path / "gen.db"))


# -- where prompts go ------------------------------------------------------------


@pytest.mark.parametrize(
    "url, remote",
    [
        ("http://127.0.0.1:7860", False),
        ("http://localhost:7860", False),
        ("http://192.168.1.20:7860", False),
        ("http://gpu-box.local:7860", False),
        ("https://api.openai.com", True),
        ("https://images.example.com", True),
        ("", False),
    ],
)
def test_remote_means_off_this_machine_and_network(url, remote):
    assert Generator(url).remote is remote


# -- the guard ----------------------------------------------------------------------


@pytest.mark.parametrize(
    "prompt, refused",
    [
        ("a misty street in Shanghai at dusk", False),
        ("a child flying a kite on a beach", False),
        ("a nude figure", True),
        ("explicit photo", True),
        ("sexual image of a teen", True),
    ],
)
def test_the_prompt_guard(prompt, refused):
    assert (check_prompt(prompt) is not None) is refused


@pytest.mark.asyncio
async def test_a_refused_prompt_never_reaches_the_generator(store: Store):
    generator, recorder = _generator()
    sid = store.create_session(mode="design")["id"]
    with pytest.raises(GenerationError):
        await create(store, generator, sid, "nsfw poster")
    assert recorder.requests == []
    assert store.session_images(sid) == []


# -- the backends --------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a1111_request_and_a_cleaned_labelled_result(store: Store):
    generator, recorder = _generator(model="sdxl.safetensors")
    sid = store.create_session(mode="design")["id"]
    image = await create(store, generator, sid, "Plane trees over a quiet lane", shape="portrait")
    sent = recorder.last
    assert recorder.requests[-1].url.path == "/sdapi/v1/txt2img"
    assert (sent["width"], sent["height"]) == (832, 1216)
    assert "nsfw" in sent["negative_prompt"]
    assert sent["override_settings"] == {"sd_model_checkpoint": "sdxl.safetensors"}
    assert image.generated and image.source == "generated"
    assert image.name.startswith("generated-plane-trees")
    assert image.alt == "Plane trees over a quiet lane"
    # Stored as a re-encoded image, like any upload.
    data = store.get_image(image.id, with_data=True).data
    assert Image.open(io.BytesIO(data)).format in ("JPEG", "PNG")


@pytest.mark.asyncio
async def test_openai_shaped_request(store: Store):
    generator, recorder = _generator("http://127.0.0.1:8080/v1", backend="openai",
                                     model="flux", key="k")
    sid = store.create_session(mode="design")["id"]
    await create(store, generator, sid, "A lighthouse", shape="landscape")
    request = recorder.requests[-1]
    assert request.url.path == "/v1/images/generations"
    assert request.headers["authorization"] == "Bearer k"
    sent = recorder.last
    assert sent["prompt"].startswith("A lighthouse")
    assert (sent["size"], sent["n"], sent["model"]) == ("1536x1024", 1, "flux")
    assert sent["response_format"] == "b64_json"


@pytest.mark.asyncio
async def test_a_link_instead_of_bytes_is_not_followed(store: Store):
    recorder = Recorder(answer={"data": [{"url": "http://169.254.169.254/latest"}]})
    generator, _ = _generator(backend="openai", recorder=recorder)
    sid = store.create_session(mode="design")["id"]
    with pytest.raises(GenerationError, match="link"):
        await create(store, generator, sid, "A lighthouse")
    assert len(recorder.requests) == 1


@pytest.mark.asyncio
async def test_generator_errors_are_sentences(store: Store):
    generator, _ = _generator(recorder=Recorder(answer={"detail": "out of memory"}, status=500))
    sid = store.create_session(mode="design")["id"]
    with pytest.raises(GenerationError, match="refused \\(500\\)"):
        await create(store, generator, sid, "A lighthouse")
    garbage = Recorder(answer={"images": [base64.b64encode(b"not an image").decode()]})
    generator, _ = _generator(recorder=garbage)
    with pytest.raises(GenerationError, match="could not be used"):
        await create(store, generator, sid, "A lighthouse")


# -- the design standard ----------------------------------------------------------------


def test_the_standard_is_folded_into_the_prompt(store: Store):
    sid = store.create_session(mode="design", design="zine")["id"]
    shaped = styled_prompt(store, sid, "A market street")
    assert shaped.startswith("A market street. In a Zine visual style")
    assert "#FF48B0" in shaped
    plain = store.create_session(mode="design")["id"]
    assert styled_prompt(store, plain, "A market street") == "A market street"


# -- the tool, the turn and the slide -----------------------------------------------------


@pytest.mark.asyncio
async def test_the_tool_labels_its_pictures_everywhere(store: Store):
    generator, _ = _generator()
    sid = store.create_session(mode="design")["id"]
    said = await GenerateImage(store, generator).use(session=sid, prompt={"text": "A harbour"})
    image_id = said.split()[1]
    assert image_id.startswith("img_")
    assert "(AI-generated)" in await ListImages(store).use(session=sid)
    await WriteSlides(store).use(session=sid, title="D", slides=[
        {"layout": "photo", "title": "Harbour", "image": {"id": image_id, "generated": False}},
    ])
    slide = json.loads(store.find_canvas_by_title(sid, "D").content)["slides"][0]
    assert slide["image"]["generated"] is True, "decided from the library, not the model"


def test_unconfigured_means_not_offered():
    tool = GenerateImage(None, Generator(""))
    assert not tool.available and "IMAGE_GEN_URL" in tool.requires


class _CallsGenerate:
    name = "mock"
    model = "mock"

    def __init__(self):
        self.calls = 0

    async def stream(self, messages, *, think=None, tools=None):
        self.calls += 1
        if self.calls == 1:
            yield Chunk(done=True, tool_calls=(ToolCall(id="g", name="generate_image",
                                                       arguments={"prompt": "A harbour"}),))
        else:
            yield Chunk(text="Done.", done=True)

    async def embed(self, texts):
        return [[0.0] * 8 for _ in texts]

    async def health(self):
        return True


def _orchestrator(store, generator):
    registry = Registry()
    registry.register(GenerateImage(store, generator))
    provider = _CallsGenerate()

    async def resolve(prefer=None):
        return type("Route", (), {"provider": provider, "reason": "local"})()

    router = type("R", (), {})()
    router.resolve = resolve
    router.invalidate_health = lambda: None
    settings = type("S", (), {"system_preamble": "You help.", "context_tokens": 8192,
                              "reply_tokens": 1024, "ollama_think": "medium",
                              "memory_max_facts": 20, "memory_fact_chars": 200})()
    return Orchestrator(settings, store, router, registry)


@pytest.mark.asyncio
async def test_a_remote_generator_is_always_asked_about(store: Store):
    generator, recorder = _generator("https://images.example.com")
    orch = _orchestrator(store, generator)
    sid = store.create_session(mode="design")["id"]
    frames = []
    async for frame in orch.run_turn(sid, "Make a picture"):
        frames.append(frame)
        if "event: skill_approval" in frame:
            payload = json.loads(frame.split("data: ", 1)[1])
            orch.approvals.resolve(payload["id"], "deny")
    joined = "".join(frames)
    assert "event: skill_approval" in joined, "asked even with ask-first off"
    assert recorder.requests == [], "declined, so nothing was sent"


@pytest.mark.asyncio
async def test_a_local_generator_just_runs(store: Store):
    generator, recorder = _generator("http://127.0.0.1:7860")
    orch = _orchestrator(store, generator)
    sid = store.create_session(mode="design")["id"]
    joined = "".join([f async for f in orch.run_turn(sid, "Make a picture")])
    assert "event: skill_approval" not in joined
    assert len(recorder.requests) == 1 and len(store.session_images(sid)) == 1


# -- HTTP ---------------------------------------------------------------------------------


def test_generator_routes_when_unconfigured(tmp_path: Path):
    settings = Settings(db_path=tmp_path / "g.db", auth_token="t", image_gen_url="")
    client = TestClient(create_app(settings), headers={"Authorization": "Bearer t"})
    assert client.get("/api/images/generator").json()["available"] is False
    sid = client.post("/api/sessions", json={}).json()["id"]
    assert client.post(f"/api/sessions/{sid}/images/generate", json={"prompt": "x"}).status_code == 400
