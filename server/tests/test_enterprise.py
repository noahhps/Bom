"""Enterprise mode, the limits it raises, and what reaches the backends.

Also the result-size fixes that came with it: a code tool's own cap now
survives the turn loop, so a command's tail and a read's paging line reach
the model.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.db import Database
from app.enterprise import (
    ENTERPRISE_KEY,
    LiveSettings,
    describe,
    enterprise_profile,
)
from app.main import create_app
from app.orchestrator import Orchestrator
from app.providers.anthropic import AnthropicProvider
from app.providers.base import Message, ToolCall
from app.providers.ollama import OllamaProvider
from app.providers.openrouter import _mark_cache
from app.providers.router import ProviderRouter
from app.skills.canvas import ReadCanvas
from app.skills.code import CodeState, code_skills
from app.store import Store


@pytest.fixture
def store(tmp_path: Path) -> Store:
    return Store(Database(tmp_path / "e.db"))


# -- the switch ---------------------------------------------------------------


def test_off_reads_the_environment_and_on_reads_the_profile(store: Store, tmp_path: Path):
    base = Settings(db_path=tmp_path / "x.db", auth_token="t")
    live = LiveSettings(base, store)

    assert live.enterprise is False
    assert live.context_tokens == base.context_tokens
    assert live.max_tool_rounds == base.max_tool_rounds
    # A setting the profile does not touch reads through either way.
    assert live.system_preamble == base.system_preamble

    live.set_enterprise(True)
    assert live.enterprise is True
    assert live.context_tokens > base.context_tokens
    assert live.cloud_context_tokens >= 1_000_000
    assert live.max_tool_rounds > base.max_tool_rounds
    assert live.result_chars > base.result_chars
    assert live.compact_at > base.compact_at
    assert live.cache_ttl == "1h"
    assert live.system_preamble == base.system_preamble


def test_the_switch_survives_a_restart(store: Store, tmp_path: Path):
    base = Settings(db_path=tmp_path / "x.db", auth_token="t")
    LiveSettings(base, store).set_enterprise(True)
    assert store.get_settings({ENTERPRISE_KEY: False})[ENTERPRISE_KEY] is True
    assert LiveSettings(base, store).enterprise is True


def test_the_profile_never_lowers_a_limit_set_higher(tmp_path: Path):
    base = SimpleNamespace(context_tokens=500_000, result_chars=1_000, compact_at=0.5)
    profile = enterprise_profile(base)
    assert profile["context_tokens"] == 500_000       # kept: already higher
    assert profile["result_chars"] == 50_000          # raised
    assert profile["compact_at"] == 0.85              # a choice, not a floor


def test_an_environment_variable_tunes_the_profile(monkeypatch):
    monkeypatch.setenv("ENTERPRISE_CONTEXT_TOKENS", "262144")
    monkeypatch.setenv("ENTERPRISE_COMPACT_AT", "0.9")
    profile = enterprise_profile(SimpleNamespace(context_tokens=65536))
    assert profile["context_tokens"] == 262144
    assert profile["compact_at"] == 0.9


def test_settings_are_read_only(store: Store, tmp_path: Path):
    live = LiveSettings(Settings(db_path=tmp_path / "x.db", auth_token="t"), store)
    with pytest.raises(AttributeError):
        live.context_tokens = 1


def test_describe_lists_both_columns(store: Store, tmp_path: Path):
    live = LiveSettings(Settings(db_path=tmp_path / "x.db", auth_token="t"), store)
    said = describe(live)
    assert said["enabled"] is False
    rows = {row["name"]: row for row in said["limits"]}
    assert rows["context_tokens"]["standard"] == 65536
    assert rows["context_tokens"]["enterprise"] == 131072
    assert rows["cache_ttl"]["enterprise"] == "1h"


def test_the_api_switches_it_and_the_backends_follow(tmp_path: Path):
    settings = Settings(db_path=tmp_path / "api.db", auth_token="t")
    app = create_app(settings)
    client = TestClient(app, headers={"Authorization": "Bearer t"})

    assert client.get("/api/enterprise").json()["enabled"] is False
    on = client.patch("/api/enterprise", json={"enabled": True}).json()
    assert on["enabled"] is True
    assert {row["name"] for row in on["limits"]} >= {"context_tokens", "compact_at"}

    # The same switch is what everything built by create_app reads.
    again = client.get("/api/enterprise").json()
    assert again["enabled"] is True
    off = client.patch("/api/enterprise", json={"enabled": False}).json()
    assert off["enabled"] is False


# -- the backends -------------------------------------------------------------


def test_apply_limits_reaches_every_backend(store: Store, tmp_path: Path):
    live = LiveSettings(Settings(db_path=tmp_path / "x.db", auth_token="t"), store)
    router = ProviderRouter(live)
    assert router.local.context_tokens == 65536
    assert router.cloud.cache_ttl == "5m"
    assert router.local.keep_alive is None

    live.set_enterprise(True)
    router.apply_limits(live)
    assert router.local.context_tokens == 131072
    assert router.network.context_tokens == 131072
    assert router.cloud.context_tokens == 1_000_000
    assert router.openrouter.context_tokens == 1_000_000
    assert router.cloud.max_tokens == 128_000
    assert router.cloud.cache_ttl == "1h"
    assert router.local.keep_alive == "1h"


class _Stream:
    """Enough of the SDK's message stream for AnthropicProvider.stream."""

    def __init__(self, request: dict) -> None:
        self.request = request

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    @property
    def text_stream(self):
        async def gen():
            yield "hi"
        return gen()

    async def get_final_message(self):
        usage = SimpleNamespace(
            input_tokens=10, output_tokens=5,
            cache_read_input_tokens=900, cache_creation_input_tokens=90,
        )
        return SimpleNamespace(stop_reason="end_turn", content=[], usage=usage)


class _Client:
    def __init__(self) -> None:
        self.requests: list[dict] = []
        outer = self

        class Messages:
            def stream(self, **request):
                outer.requests.append(request)
                return _Stream(request)

        class Models:
            async def retrieve(self, model):
                return SimpleNamespace(max_input_tokens=200_000, max_tokens=64_000)

        self.messages = Messages()
        self.models = Models()


@pytest.mark.asyncio
async def test_anthropic_requests_are_cached_and_capped():
    provider = AnthropicProvider(max_tokens=128_000)
    provider._client = _Client()
    provider.cache_ttl = "1h"
    await provider.context_window()  # learns the model's own limits

    chunks = [c async for c in provider.stream(
        [Message(role="system", content="You help."), Message(role="user", content="hello")]
    )]
    request = provider._client.requests[0]

    # Both breakpoints, at the hour.
    assert request["system"][0]["cache_control"] == {"type": "ephemeral", "ttl": "1h"}
    assert request["extra_body"]["cache_control"] == {"type": "ephemeral", "ttl": "1h"}
    # A 128k cap on a model that writes at most 64k is sent as 64k.
    assert request["max_tokens"] == 64_000
    # And the cache shows up in what the turn reports.
    done = chunks[-1]
    assert done.prompt_tokens == 10 + 900 + 90
    assert done.meta["cache_read_tokens"] == 900
    assert done.meta["cache_write_tokens"] == 90


@pytest.mark.asyncio
async def test_anthropic_default_ttl_sends_no_ttl():
    provider = AnthropicProvider()
    provider._client = _Client()
    _ = [c async for c in provider.stream([Message(role="user", content="hi")])]
    assert provider._client.requests[0]["extra_body"]["cache_control"] == {"type": "ephemeral"}


def test_openrouter_marks_cache_only_where_it_must_be_asked_for():
    encoded = [
        {"role": "system", "content": "You help."},
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": None, "tool_calls": []},
        {"role": "tool", "tool_call_id": "1", "content": "result"},
    ]
    _mark_cache(encoded, "openai/gpt-5", "5m")
    assert encoded[0]["content"] == "You help."  # cached upstream on its own

    _mark_cache(encoded, "anthropic/claude-opus-5-5", "1h")
    control = {"type": "ephemeral", "ttl": "1h"}
    assert encoded[0]["content"] == [{"type": "text", "text": "You help.", "cache_control": control}]
    assert encoded[3]["content"] == [{"type": "text", "text": "result", "cache_control": control}]
    assert encoded[1]["content"] == "hello"  # only the two breakpoints


@pytest.mark.asyncio
async def test_ollama_keeps_the_model_loaded_when_asked(monkeypatch):
    provider = OllamaProvider("http://ollama.test", "m")
    sent: list[dict] = []

    class _Response:
        status_code = 200

        async def aiter_lines(self):
            yield json.dumps({"message": {"content": "ok"}, "done": True})

    class _Ctx:
        def __init__(self, payload):
            sent.append(payload)

        async def __aenter__(self):
            return _Response()

        async def __aexit__(self, *exc):
            return False

    monkeypatch.setattr(provider._client, "stream", lambda method, url, json: _Ctx(json))
    _ = [c async for c in provider.stream([Message(role="user", content="hi")])]
    assert "keep_alive" not in sent[-1]
    provider.keep_alive = "1h"
    _ = [c async for c in provider.stream([Message(role="user", content="hi")])]
    assert sent[-1]["keep_alive"] == "1h"


# -- results that survive the turn loop ----------------------------------------


def _code_project(tmp_path: Path) -> tuple[Path, Path]:
    base = (tmp_path / "home")
    root = base / "app"
    root.mkdir(parents=True)
    (root / ".git").mkdir()
    return base.resolve(), root.resolve()


def _orchestrator(store: Store, settings) -> Orchestrator:
    from app.skills.registry import Registry

    registry = Registry()
    for skill in code_skills(store, settings, CodeState()):
        registry.register(skill)
    return Orchestrator(settings, store, router=None, registry=registry)


@pytest.mark.asyncio
async def test_a_commands_tail_reaches_the_model(store: Store, tmp_path: Path):
    base, root = _code_project(tmp_path)
    settings = SimpleNamespace(
        workspace_roots=(base,), code_timeout=20, code_timeout_max=30,
        code_output_chars=30_000, result_chars=12_000,
    )
    orch = _orchestrator(store, settings)
    sid = store.create_session(mode="code", workspace=str(root))["id"]
    command = (
        "python3 -c \"import sys\n"
        "for i in range(3000): print(f'test_{i} PASSED')\n"
        "print('=== 1 failed, 2999 passed ===')\""
    )
    result = await orch._run_skill(
        ToolCall(id="1", name="code_bash", arguments={"command": command}), sid
    )
    # Clipped by the tool to its head and tail -- and no longer cut again,
    # from the end, on the way to the model.
    assert "1 failed, 2999 passed" in result
    assert "characters cut" in result


@pytest.mark.asyncio
async def test_a_long_read_keeps_its_paging_line(store: Store, tmp_path: Path):
    base, root = _code_project(tmp_path)
    (root / "big.py").write_text(
        "\n".join(f"x_{i} = compute_something_long({i})  # padding" for i in range(1500))
    )
    settings = SimpleNamespace(
        workspace_roots=(base,), code_timeout=20, code_timeout_max=30,
        code_output_chars=30_000, result_chars=12_000,
    )
    orch = _orchestrator(store, settings)
    sid = store.create_session(mode="code", workspace=str(root))["id"]
    result = await orch._run_skill(
        ToolCall(id="1", name="code_read", arguments={"path": "big.py"}), sid
    )
    assert "read on with offset=" in result
    assert "[cut:" not in result


def test_readers_follow_the_live_setting(store: Store, tmp_path: Path):
    live = LiveSettings(Settings(db_path=tmp_path / "x.db", auth_token="t"), store)
    reader = ReadCanvas(store, settings=live)
    standard = reader.max_chars
    live.set_enterprise(True)
    assert reader.max_chars > standard
    assert reader.max_result_chars > reader.max_chars
