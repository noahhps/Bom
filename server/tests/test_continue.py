"""Running out of skill rounds: the truncated/continuable signal, and the cap."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.db import Database
from app.orchestrator import Orchestrator
from app.providers.base import Chunk, ToolCall
from app.skills.registry import Registry
from app.skills.skill import Skill
from app.store import Store


class _Echo(Skill):
    def __init__(self) -> None:
        super().__init__(name="ping", description="ping")

    async def use(self, **kwargs) -> str:
        return "pong"


class _NeverStops:
    """Asks for a skill on every round, so it never finishes on its own."""

    name = "mock"
    model = "mock"

    def __init__(self, *, text: str) -> None:
        self._text = text

    async def stream(self, messages, *, think=None, tools=None):
        yield Chunk(
            text=self._text,
            done=True,
            tool_calls=(ToolCall(id="1", name="ping", arguments={}),),
        )

    async def embed(self, texts):
        return [[0.0] * 8 for _ in texts]

    async def health(self):
        return True


def _orchestrator(tmp_path: Path, provider, rounds: int) -> tuple[Orchestrator, Store]:
    store = Store(Database(tmp_path / "t.db"))
    registry = Registry()
    registry.register(_Echo())
    router = type("R", (), {})()
    router.resolve = lambda prefer=None: _route(provider)
    router.invalidate_health = lambda: None
    settings = type(
        "S",
        (),
        {
            "system_preamble": "You help.",
            "context_tokens": 8192,
            "reply_tokens": 1024,
            "ollama_think": "medium",
            "memory_max_facts": 20,
            "memory_fact_chars": 200,
            "max_tool_rounds": rounds,
        },
    )()
    return Orchestrator(settings, store, router, registry), store


async def _route(provider):
    return type("Route", (), {"provider": provider, "reason": "local"})()


async def _run(orch: Orchestrator, store: Store) -> str:
    sid = store.create_session()["id"]
    return "".join([frame async for frame in orch.run_turn(sid, "go")])


@pytest.mark.asyncio
async def test_exhausted_with_text_marks_the_done_frame_truncated(tmp_path: Path):
    orch, store = _orchestrator(tmp_path, _NeverStops(text="working "), rounds=3)
    joined = await _run(orch, store)
    assert "event: done" in joined
    assert '"truncated": true' in joined


@pytest.mark.asyncio
async def test_exhausted_with_no_text_is_a_continuable_error(tmp_path: Path):
    orch, store = _orchestrator(tmp_path, _NeverStops(text=""), rounds=3)
    joined = await _run(orch, store)
    assert "event: error" in joined
    assert '"continuable": true' in joined


@pytest.mark.asyncio
async def test_the_cap_is_the_configured_number_of_rounds(tmp_path: Path):
    provider = _NeverStops(text="working ")
    orch, store = _orchestrator(tmp_path, provider, rounds=4)
    # ping runs once per round; a turn that ran out at 4 rounds ran the skill
    # exactly 4 times. (The count lives in the persisted trace.)
    sid = store.create_session()["id"]
    async for _ in orch.run_turn(sid, "go"):
        pass
    assistant = next(m for m in store.list_messages(sid) if m.role == "assistant")
    assert len(assistant.to_dict()["skills"]) == 4


@pytest.mark.asyncio
async def test_a_normal_finish_is_not_truncated(tmp_path: Path):
    class _Finishes(_NeverStops):
        async def stream(self, messages, *, think=None, tools=None):
            yield Chunk(text="done.", done=True)  # no tool calls

    orch, store = _orchestrator(tmp_path, _Finishes(text=""), rounds=3)
    joined = await _run(orch, store)
    assert '"truncated": false' in joined
