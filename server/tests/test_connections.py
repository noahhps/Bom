"""Connections to OpenAI-compatible services: the provider against a service
stood up in memory, the router's handling of them, and the API that manages
them."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.db import Database
from app.main import create_app
from app.providers.base import ContextOverflow, Message, ProviderError
from app.providers.openai_compat import OpenAICompatProvider
from app.providers.presets import CONNECTION_PRESETS, get_connection_preset
from app.providers.router import LOCAL, ProviderRouter
from app.store import Store
from app.thinking import control_for_connection


def _sse(*events) -> str:
    return "".join(f"data: {json.dumps(e)}\n\n" for e in events) + "data: [DONE]\n\n"


class Service:
    """An OpenAI-compatible service: /models and a streaming /chat/completions."""

    def __init__(self, *, key: str = "sk-good", refuse: tuple[str, ...] = (), listing=None):
        self.key = key
        self.refuse = set(refuse)
        self.requests: list[dict] = []
        self.headers: list[dict] = []
        self.listing = listing if listing is not None else {"data": [
            {"id": "gpt-test", "owned_by": "test", "context_window": 64000},
            {"id": "text-embedding-3-small"},
            {"id": "whisper-1"},
        ]}
        self.reply = [
            {"choices": [{"delta": {"reasoning_content": "Thinking it over. "}}]},
            {"choices": [{"delta": {"content": "Hello"}}]},
            {"choices": [{"delta": {"content": " there."}, "finish_reason": "stop"}]},
            {"choices": [], "usage": {"prompt_tokens": 120, "completion_tokens": 9,
                                      "prompt_tokens_details": {"cached_tokens": 100}}},
        ]

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.headers.append(dict(request.headers))
        auth = request.headers.get("authorization", "")
        if self.key and auth != f"Bearer {self.key}":
            return httpx.Response(401, json={"error": {"message": "Incorrect API key"}})
        path = request.url.path
        if path.endswith("/models"):
            return httpx.Response(200, json=self.listing)
        if path.endswith("/chat/completions"):
            body = json.loads(request.content)
            self.requests.append(body)
            for name in self.refuse:
                if name in body:
                    return httpx.Response(400, json={"error": {
                        "message": f"Unsupported parameter: '{name}' is not supported with this model."}})
            if any("too long" in (m.get("content") or "") for m in body["messages"] if isinstance(m.get("content"), str)):
                return httpx.Response(400, json={"error": {"message": "This model's maximum context length is 8192 tokens"}})
            return httpx.Response(200, text=_sse(*self.reply), headers={"content-type": "text/event-stream"})
        return httpx.Response(404)

    def factory(self):
        return lambda: httpx.AsyncClient(transport=httpx.MockTransport(self.handler))


def _provider(service: Service, preset_id: str = "openai", **kw) -> OpenAICompatProvider:
    preset = get_connection_preset(preset_id)
    provider = OpenAICompatProvider(
        connection_id="c1", name=preset_id, label=preset["label"],
        base_url=kw.pop("base_url", preset["base_url"] or "http://svc.test/v1"),
        api_key=kw.pop("api_key", "sk-good"), model=kw.pop("model", "gpt-test"), preset=preset, **kw,
    )
    provider._client = service.factory()()
    return provider


# -- the provider -----------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_reply_streams_its_reasoning_text_and_usage():
    service = Service()
    chunks = [c async for c in _provider(service).stream([Message(role="user", content="hi")])]
    assert "".join(c.thinking for c in chunks) == "Thinking it over. "
    assert "".join(c.text for c in chunks) == "Hello there."
    done = chunks[-1]
    assert done.done and done.prompt_tokens == 120 and done.completion_tokens == 9
    assert done.meta["cache_read_tokens"] == 100
    sent = service.requests[0]
    assert sent["stream"] is True and sent["stream_options"] == {"include_usage": True}


@pytest.mark.asyncio
async def test_tool_calls_are_reassembled_from_fragments():
    service = Service()
    service.reply = [
        {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_1", "function": {"name": "code_read", "arguments": '{"pa'}}]}}]},
        {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": 'th": "a.py"}'}}]}, "finish_reason": "tool_calls"}]},
    ]
    tools = [{"name": "code_read", "description": "read", "parameters": {"type": "object", "properties": {}}}]
    chunks = [c async for c in _provider(service).stream([Message(role="user", content="read it")], tools=tools)]
    call = chunks[-1].tool_calls[0]
    assert call.name == "code_read" and call.arguments == {"path": "a.py"} and call.id == "call_1"
    assert service.requests[0]["tools"][0]["function"]["name"] == "code_read"


@pytest.mark.asyncio
async def test_a_refused_optional_parameter_is_dropped_and_remembered():
    service = Service(refuse=("reasoning_effort",))
    provider = _provider(service)
    chunks = [c async for c in provider.stream([Message(role="user", content="hi")], think="high")]
    assert "".join(c.text for c in chunks) == "Hello there."
    assert service.requests[0]["reasoning_effort"] == "high"
    assert "reasoning_effort" not in service.requests[1]
    # The next turn does not ask again.
    _ = [c async for c in provider.stream([Message(role="user", content="hi")], think="high")]
    assert "reasoning_effort" not in service.requests[2]
    assert len(service.requests) == 3


@pytest.mark.asyncio
async def test_effort_is_sent_only_where_the_service_takes_it():
    service = Service()
    _ = [c async for c in _provider(service, "groq", base_url="http://svc.test/v1").stream(
        [Message(role="user", content="hi")], think="high")]
    assert "reasoning_effort" not in service.requests[0]
    assert control_for_connection(CONNECTION_PRESETS["openai"]).mode == "effort"
    assert control_for_connection(CONNECTION_PRESETS["groq"]).mode == "none"


@pytest.mark.asyncio
async def test_mistral_is_not_sent_the_usage_option():
    service = Service()
    _ = [c async for c in _provider(service, "mistral").stream([Message(role="user", content="hi")])]
    assert "stream_options" not in service.requests[0]


@pytest.mark.asyncio
async def test_errors_say_what_to_do():
    with pytest.raises(ProviderError, match="rejected the key"):
        _ = [c async for c in _provider(Service(), api_key="sk-bad").stream([Message(role="user", content="hi")])]
    with pytest.raises(ContextOverflow):
        _ = [c async for c in _provider(Service()).stream([Message(role="user", content="too long")])]
    with pytest.raises(ProviderError, match="not connected"):
        _ = [c async for c in _provider(Service(), api_key="").stream([Message(role="user", content="hi")])]
    with pytest.raises(ProviderError, match="Pick a model"):
        _ = [c async for c in _provider(Service(), model="").stream([Message(role="user", content="hi")])]


@pytest.mark.asyncio
async def test_the_listing_keeps_chat_models_and_what_it_says_about_them():
    provider = _provider(Service())
    models = await provider.list_models()
    assert [m["id"] for m in models] == ["gpt-test"]
    assert await provider.context_window() == 64000
    assert await provider.health() is True
    assert await _provider(Service(), api_key="sk-bad").health() is False


@pytest.mark.asyncio
async def test_listings_in_other_shapes():
    # Together answers with a bare list; Gemini prefixes its ids.
    together = _provider(Service(listing=[{"id": "meta-llama/Llama-3.3-70B", "context_length": 131072}]), "together")
    assert [m["id"] for m in await together.list_models()] == ["meta-llama/Llama-3.3-70B"]
    gemini = _provider(Service(listing={"data": [{"id": "models/gemini-2.5-flash"}]}), "gemini")
    assert [m["id"] for m in await gemini.list_models()] == ["gemini-2.5-flash"]


@pytest.mark.asyncio
async def test_a_local_server_needs_no_key_and_is_not_sent_pictures():
    service = Service(key="")
    provider = _provider(service, "lmstudio", api_key="")
    assert provider.configured
    assert await provider.health()
    assert await provider.sees_images() is False
    assert "authorization" not in service.headers[-1]


@pytest.mark.asyncio
async def test_azure_gets_its_own_key_header_too():
    service = Service()
    provider = _provider(service, "azure_openai", base_url="https://acme.openai.azure.com/openai/v1")
    await provider.health()
    assert service.headers[-1]["api-key"] == "sk-good"
    assert service.headers[-1]["authorization"] == "Bearer sk-good"


# -- the router ----------------------------------------------------------------------


def _router(tmp_path: Path) -> ProviderRouter:
    return ProviderRouter(Settings(db_path=tmp_path / "r.db", auth_token="t"))


def test_connections_become_backends_and_join_the_fallback(tmp_path: Path):
    router = _router(tmp_path)
    router.load_connections([
        {"id": "conn_a", "preset": "groq", "name": "Groq", "base_url": "https://api.groq.com/openai/v1",
         "api_key": "k", "model": "llama", "enabled": 1},
        {"id": "conn_b", "preset": "lmstudio", "name": "Desk", "base_url": "http://10.0.0.5:1234/v1",
         "api_key": None, "model": "qwen", "enabled": 1},
        {"id": "conn_off", "preset": "openai", "name": "Off", "base_url": "https://api.openai.com/v1",
         "api_key": "k", "model": "m", "enabled": 0},
    ])
    assert {"conn_a", "conn_b"} <= set(router.by_id) and "conn_off" not in router.by_id
    assert router.fallback() == ["network", "openrouter", "cloud", "conn_a", "conn_b"]
    assert router.by_id["conn_b"].label == "Desk"
    # Windowed like what they are.
    assert router.by_id["conn_a"].context_tokens == 200_000
    assert router.by_id["conn_b"].context_tokens == 65536

    router.set_fallback_order(["conn_b", "cloud", LOCAL])
    assert router.fallback() == ["conn_b", "cloud", "network", "openrouter", "conn_a"]

    # A changed key or model keeps the same provider object.
    same = router.by_id["conn_a"]
    router.load_connections([
        {"id": "conn_a", "preset": "groq", "name": "Groq", "base_url": "https://api.groq.com/openai/v1",
         "api_key": "k2", "model": "llama-2", "enabled": 1},
    ])
    assert router.by_id["conn_a"] is same and same.api_key == "k2" and same.model == "llama-2"
    assert "conn_b" not in router.by_id


@pytest.mark.asyncio
async def test_auto_falls_back_to_a_connection_in_order(tmp_path: Path):
    router = _router(tmp_path)
    router.load_connections([{"id": "conn_a", "preset": "groq", "name": "Groq",
                              "base_url": "https://api.groq.com/openai/v1", "api_key": "k",
                              "model": "llama", "enabled": 1}])

    async def down():
        return False

    async def up():
        return True

    for provider_id in ("local", "network", "openrouter", "cloud"):
        router.by_id[provider_id].health = down
    router.by_id["conn_a"].health = up
    route = await router.resolve()
    assert route.provider is router.by_id["conn_a"] and route.reason == "fallback"
    assert (await router.resolve("conn_a")).provider is router.by_id["conn_a"]


# -- over HTTP -----------------------------------------------------------------------


@pytest.fixture
def service(monkeypatch) -> Service:
    svc = Service()
    monkeypatch.setattr(OpenAICompatProvider, "client_factory", staticmethod(svc.factory()))
    return svc


def _client(tmp_path: Path) -> TestClient:
    app = create_app(Settings(db_path=tmp_path / "api.db", auth_token="t"))
    return TestClient(app, headers={"Authorization": "Bearer t"})


def test_adding_a_connection_over_the_api(tmp_path: Path, service: Service):
    client = _client(tmp_path)
    presets = {p["id"] for p in client.get("/api/connections/presets").json()["presets"]}
    assert {"openai", "gemini", "groq", "lmstudio", "vllm", "custom"} <= presets

    # Checked before it is saved: a wrong key is caught on the form.
    bad = client.post("/api/connections/check", json={"preset": "openai", "api_key": "sk-bad"}).json()
    assert bad["ok"] is False and "rejected the key" in bad["error"]
    good = client.post("/api/connections/check", json={"preset": "openai", "api_key": "sk-good"}).json()
    assert good["ok"] and [m["id"] for m in good["models"]] == ["gpt-test"]
    assert client.post("/api/connections/check", json={"preset": "openai"}).status_code == 400

    added = client.post("/api/connections", json={
        "preset": "openai", "api_key": "sk-good", "model": "gpt-test"}).json()
    assert added["label"] == "OpenAI" and added["healthy"] is True
    assert added["thinking"]["mode"] == "effort"
    assert added["connection"]["has_key"] is True
    conn_id = added["id"]

    listing = client.get("/api/models").json()
    assert conn_id in [p["id"] for p in listing["providers"]]
    assert listing["order"][-1] == conn_id
    # The key never comes back.
    assert "sk-good" not in json.dumps(listing)

    # A model picked in the menu is kept on the connection.
    assert client.put(f"/api/providers/{conn_id}/model", json={"model": "gpt-test"}).status_code == 200

    # Switched off: no longer a backend, still listed.
    client.patch(f"/api/connections/{conn_id}", json={"enabled": False})
    listing = client.get("/api/models").json()
    assert conn_id not in [p["id"] for p in listing["providers"]]
    assert [c["enabled"] for c in listing["connections"]] == [False]

    client.patch(f"/api/connections/{conn_id}", json={"enabled": True, "name": "Work OpenAI"})
    order = client.put("/api/providers/order", json={"order": [conn_id, "cloud"]}).json()["order"]
    assert order[:2] == [conn_id, "cloud"]

    # All of it survives a restart.
    again = _client(tmp_path)
    listing = again.get("/api/models").json()
    entry = next(p for p in listing["providers"] if p["id"] == conn_id)
    assert entry["label"] == "Work OpenAI" and entry["model"] == "gpt-test"
    assert listing["order"][0] == conn_id

    assert again.delete(f"/api/connections/{conn_id}").json()["ok"] is True
    assert conn_id not in [p["id"] for p in again.get("/api/models").json()["providers"]]


def test_only_editable_presets_take_another_address(tmp_path: Path, service: Service):
    client = _client(tmp_path)
    added = client.post("/api/connections", json={
        "preset": "openai", "api_key": "sk-good", "base_url": "http://evil.test/v1"}).json()
    assert added["connection"]["base_url"] == "https://api.openai.com/v1"
    local = client.post("/api/connections", json={
        "preset": "vllm", "base_url": "http://10.0.0.9:8000/v1/"}).json()
    assert local["connection"]["base_url"] == "http://10.0.0.9:8000/v1"
    assert client.post("/api/connections", json={"preset": "custom"}).status_code == 400
    assert client.post("/api/connections", json={"preset": "azure_openai", "api_key": "k"}).status_code == 400


def test_a_chat_turn_answers_from_a_connection(tmp_path: Path, service: Service):
    client = _client(tmp_path)
    added = client.post("/api/connections", json={
        "preset": "groq", "api_key": "sk-good", "model": "gpt-test"}).json()
    with client.stream("POST", "/api/chat", json={"message": "hello", "provider": added["id"]}) as r:
        body = "".join(r.iter_text())
    frames = [f for f in body.split("\n\n") if f.startswith("event: delta")]
    answer = "".join(json.loads(f.split("data: ", 1)[1])["text"] for f in frames)
    assert answer == "Hello there."
    assert '"provider": "groq"' in body


def test_the_anthropic_key_is_checked_and_kept(tmp_path: Path, monkeypatch):
    client = _client(tmp_path)
    cloud = client.app.state.providers.cloud

    class Refusing:
        class models:
            @staticmethod
            async def list(limit=1):
                raise RuntimeError("invalid x-api-key")

    monkeypatch.setattr(cloud, "_ensure_client", lambda: Refusing())
    response = client.put("/api/providers/cloud/key", json={"key": "sk-ant-bad"})
    assert response.status_code == 400 and "did not accept" in response.json()["detail"]
    assert cloud.api_key == ""

    class Accepting:
        class models:
            @staticmethod
            async def list(limit=1):
                return []

    monkeypatch.setattr(cloud, "_ensure_client", lambda: Accepting())
    assert client.put("/api/providers/cloud/key", json={"key": "sk-ant-good"}).status_code == 200
    assert cloud.api_key == "sk-ant-good" and cloud.configured
    assert (tmp_path / "anthropic_key").exists() is False  # kept where settings say
    client.put("/api/providers/cloud/key", json={"key": ""})
    assert cloud.api_key == ""
