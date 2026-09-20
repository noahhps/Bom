"""Carrying a turn's working (tool results + reasoning) into later turns."""

from __future__ import annotations

from pathlib import Path

from app.db import Database
from app.orchestrator import Orchestrator
from app.store import Store


def _settings(carry: bool):
    return type(
        "S",
        (),
        {
            "system_preamble": "You help.",
            "context_tokens": 8192,
            "reply_tokens": 1024,
            "ollama_think": "medium",
            "memory_max_facts": 20,
            "memory_fact_chars": 200,
            "carry_working": carry,
        },
    )()


def _history_with_working(store: Store) -> tuple[str, list]:
    sid = store.create_session()["id"]
    store.add_message(sid, "user", "what is 6*7?")
    a = store.add_message(sid, "assistant", "It is 42.")
    store.update_message(
        a.id,
        "It is 42.",
        reasoning="I should compute this rather than guess; the run returned 42.",
        skills=[{"name": "run_python", "arguments": {"code": "print(6*7)"}, "result": "42"}],
        tokens=10,
        model="m",
        provider="p",
    )
    return sid, store.list_messages(sid)


def _assistant(window):
    return next(m for m in window if m.role == "assistant")


def test_working_is_carried_into_the_window(tmp_path: Path):
    store = Store(Database(tmp_path / "t.db"))
    sid, history = _history_with_working(store)
    orch = Orchestrator(_settings(True), store, router=None, registry=None)

    window = orch.build_window(history, {}, system="SYS", session_id=sid)
    msg = _assistant(window)
    assert "It is 42." in msg.content          # the answer is still there
    assert "run_python" in msg.content          # the tool it used
    assert "42" in msg.content                   # a trimmed result
    assert "Your reasoning then" in msg.content  # the deliberation tail


def test_working_is_omitted_when_switched_off(tmp_path: Path):
    store = Store(Database(tmp_path / "t.db"))
    sid, history = _history_with_working(store)
    orch = Orchestrator(_settings(False), store, router=None, registry=None)

    msg = _assistant(orch.build_window(history, {}, system="SYS", session_id=sid))
    assert "It is 42." in msg.content
    assert "run_python" not in msg.content
    assert "Your reasoning then" not in msg.content


def test_a_plain_turn_carries_nothing_extra(tmp_path: Path):
    store = Store(Database(tmp_path / "t.db"))
    sid = store.create_session()["id"]
    store.add_message(sid, "user", "hello")
    store.add_message(sid, "assistant", "Hi there.")
    orch = Orchestrator(_settings(True), store, router=None, registry=None)

    msg = _assistant(orch.build_window(store.list_messages(sid), {}, system="SYS", session_id=sid))
    # No tools, no reasoning -> the content is exactly the answer, no recap block.
    assert msg.content == "Hi there."
