"""Compaction, and the other things that keep a long conversation's window
both inside its budget and stable enough to stay cached."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from app import compaction
from app.db import Database
from app.orchestrator import Orchestrator
from app.providers.base import Chunk, ContextOverflow, Message, ToolCall
from app.skills.registry import Registry
from app.skills.skill import Skill
from app.store import Store


@pytest.fixture
def store(tmp_path: Path) -> Store:
    return Store(Database(tmp_path / "c.db"))


def _settings(**extra):
    values = {
        "system_preamble": "You help.",
        "context_tokens": 8192,
        "reply_tokens": 1024,
        "ollama_think": "medium",
        "memory_max_facts": 20,
        "memory_fact_chars": 200,
        "compact_at": 0.5,
        "compact_keep": 0.25,
        "compact_summary_tokens": 300,
    }
    values.update(extra)
    return SimpleNamespace(**values)


class _Model:
    """Records every window it is sent. Writes a summary when asked to
    compact, and otherwise answers -- or asks for `tool` while it has calls
    left to make."""

    name = "mock"
    model = "mock"

    def __init__(self, *, calls: int = 0, tool: str = "big", fail_summary: bool = False,
                 overflow_over: int | None = None):
        self.windows: list[list[Message]] = []
        self.summaries = 0
        self.calls = calls
        self.tool = tool
        self.fail_summary = fail_summary
        self.overflow_over = overflow_over

    async def stream(self, messages, *, think=None, tools=None):
        system = messages[0].content if messages and messages[0].role == "system" else ""
        if system.startswith("You compact"):
            self.summaries += 1
            if self.fail_summary:
                yield Chunk(done=True)
                return
            yield Chunk(text="Goals: build the thing. Where it stands: halfway.", done=True)
            return
        size = sum(len(m.content) for m in messages)
        if self.overflow_over is not None and size > self.overflow_over:
            self.windows.append(list(messages))
            raise ContextOverflow("prompt is too long")
        self.windows.append(list(messages))
        if self.calls > 0:
            self.calls -= 1
            yield Chunk(
                done=True,
                tool_calls=(ToolCall(id=f"c{self.calls}", name=self.tool, arguments={}),),
            )
            return
        yield Chunk(text="Done.", done=True)

    async def context_window(self):
        return 8192


class _Big(Skill):
    def __init__(self, size: int) -> None:
        super().__init__(name="big", description="returns a lot")
        self.size = size
        self.n = 0

    async def use(self, **kwargs) -> str:
        self.n += 1
        return f"result {self.n}: " + "x" * self.size


def _orchestrator(store: Store, model: _Model, settings=None, registry=None) -> Orchestrator:
    router = SimpleNamespace(invalidate_health=lambda: None)

    async def resolve(prefer=None):
        return SimpleNamespace(provider=model, reason="local")

    router.resolve = resolve
    return Orchestrator(settings or _settings(), store, router, registry)


def _long_history(store: Store, turns: int, size: int = 1600) -> str:
    sid = store.create_session()["id"]
    for i in range(turns):
        store.add_message(sid, "user", f"question {i}: " + "q" * size)
        store.add_message(sid, "assistant", f"answer {i}: " + "a" * size)
    return sid


async def _turn(orch: Orchestrator, sid: str, text: str = "next?") -> list[tuple[str, dict]]:
    frames = []
    async for frame in orch.run_turn(sid, text):
        event = frame.split("\n", 1)[0].removeprefix("event: ")
        data = json.loads(frame.split("data: ", 1)[1])
        frames.append((event, data))
    return frames


# -- planning -----------------------------------------------------------------


def test_the_kept_tail_starts_on_a_user_message():
    roles = ["user", "assistant"] * 3 + ["user"]
    costs = [100] * 7
    split = compaction.plan_split(costs, roles, keep_tokens=250)
    assert roles[split] == "user"
    assert split == 6   # 250 keeps the newest two, and the turn cannot be split

    split = compaction.plan_split(costs, roles, keep_tokens=350)
    assert split == 4   # the last whole turn and the question


def test_the_newest_message_is_kept_even_alone_over_the_allowance():
    assert compaction.plan_split([100, 100, 5000], ["user", "assistant", "user"], 10) == 2


def test_nothing_to_fold_is_none():
    assert compaction.plan_split([100], ["user"], 10) is None
    assert compaction.plan_split([], [], 10) is None


# -- clearing inside a turn ------------------------------------------------------


def test_clearing_keeps_the_latest_round_and_every_pair():
    window = [
        Message(role="system", content="S"),
        Message(role="user", content="history"),
        Message(role="user", content="the question"),                     # anchor
        Message(role="assistant", content="", tool_calls=(
            ToolCall(id="a", name="code_write", arguments={"path": "f", "content": "y" * 5000}),
        )),
        Message(role="tool", content="first " + "r" * 3000, tool_call_id="a", tool_name="code_write"),
        Message(role="assistant", content="", tool_calls=(ToolCall(id="b", name="code_read", arguments={}),)),
        Message(role="tool", content="latest " + "r" * 3000, tool_call_id="b", tool_name="code_read"),
    ]
    cleared, count = compaction.clear_old_results(window, anchor=2)
    assert count == 1
    assert cleared[4].content.startswith("[Cleared to save context")
    assert cleared[4].tool_call_id == "a"                 # still answers its call
    assert "first" in cleared[4].content                  # says what it was
    assert cleared[6].content == window[6].content        # the latest round is whole
    assert len(cleared[3].tool_calls[0].arguments["content"]) < 1000  # applied, shortened
    assert cleared[3].tool_calls[0].arguments["path"] == "f"
    assert cleared[1].content == "history"                # before the turn: untouched
    # Clearing again finds nothing new to clear.
    assert compaction.clear_old_results(cleared, anchor=2)[1] == 0


# -- compacting a conversation ---------------------------------------------------


@pytest.mark.asyncio
async def test_a_long_history_is_compacted_and_then_held(store: Store):
    sid = _long_history(store, turns=6)
    model = _Model()
    orch = _orchestrator(store, model)

    frames = await _turn(orch, sid, "and now?")
    statuses = [d["status"] for e, d in frames if e == "compaction"]
    assert statuses == ["started", "done"]
    assert model.summaries == 1

    stored = store.latest_compaction(sid)
    assert stored and "halfway" in stored["summary"]
    window = model.windows[-1]
    assert window[1].role == "user"
    assert window[1].content.startswith(compaction.SUMMARY_OPEN)
    assert "halfway" in window[1].content
    # The oldest turns are no longer sent word for word; the question is.
    sent = "\n".join(m.content for m in window)
    assert "question 0:" not in sent
    assert window[-1].content.endswith("and now?")
    # The thread itself keeps every message.
    assert len(store.list_messages(sid)) == 6 * 2 + 2

    # The next turn reuses the summary, and opens exactly as this one did --
    # the stable start a cache needs.
    await _turn(orch, sid, "and then?")
    assert model.summaries == 1
    assert model.windows[-1][1].content == window[1].content
    assert model.windows[-1][0].content == window[0].content


@pytest.mark.asyncio
async def test_a_short_history_is_left_alone(store: Store):
    sid = _long_history(store, turns=1, size=100)
    model = _Model()
    frames = await _turn(_orchestrator(store, model), sid)
    assert not [e for e, _ in frames if e == "compaction"]
    assert model.summaries == 0
    assert store.latest_compaction(sid) is None


@pytest.mark.asyncio
async def test_enterprise_compacts_later(store: Store):
    # Enough history to compact at half the window, not at 85% of it:
    # ten messages of ~380 tokens against a room of ~7,100.
    sid = _long_history(store, turns=5, size=1500)
    standard = _Model()
    await _turn(_orchestrator(store, standard), sid)
    assert standard.summaries == 1

    sid = _long_history(store, turns=5, size=1500)
    enterprise = _Model()
    await _turn(
        _orchestrator(store, enterprise, _settings(compact_at=0.85, compact_keep=0.4)), sid
    )
    assert enterprise.summaries == 0


@pytest.mark.asyncio
async def test_a_summary_that_fails_leaves_the_turn_answering(store: Store):
    sid = _long_history(store, turns=6)
    model = _Model(fail_summary=True)
    frames = await _turn(_orchestrator(store, model), sid)
    statuses = [d["status"] for e, d in frames if e == "compaction"]
    assert statuses == ["started", "failed"]
    assert store.latest_compaction(sid) is None
    assert any(e == "done" for e, _ in frames)
    # Trimmed instead, and still opening on a user message.
    assert model.windows[-1][1].role == "user"


@pytest.mark.asyncio
async def test_a_deleted_message_sets_the_summary_aside(store: Store):
    sid = _long_history(store, turns=6)
    model = _Model()
    orch = _orchestrator(store, model)
    await _turn(orch, sid)
    through = store.latest_compaction(sid)["through_id"]
    store.delete_message(through)
    summary, start = orch._compacted(sid, store.list_messages(sid))
    assert summary is None and start == 0


# -- inside a long turn ----------------------------------------------------------


@pytest.mark.asyncio
async def test_a_long_turn_clears_its_earlier_results(store: Store):
    sid = store.create_session()["id"]
    registry = Registry()
    registry.register(_Big(size=6000))
    model = _Model(calls=6)
    frames = await _turn(_orchestrator(store, model, registry=registry), sid)

    cleared = [d for e, d in frames if e == "compaction" and d["status"] == "cleared"]
    assert cleared, "the window outgrew its budget and nothing was cleared"
    last = model.windows[-1]
    tools = [m for m in last if m.role == "tool"]
    assert tools[-1].content.startswith("result ")            # the latest, whole
    assert any(m.content.startswith("[Cleared") for m in tools)
    # Every call still has its result, in order.
    asked = [c.id for m in last if m.role == "assistant" for c in m.tool_calls]
    assert asked == [m.tool_call_id for m in tools]
    assert any(e == "done" for e, _ in frames)


@pytest.mark.asyncio
async def test_an_overflow_retries_with_the_question_and_whole_pairs(store: Store):
    sid = store.create_session()["id"]
    registry = Registry()
    registry.register(_Big(size=1500))
    # Two rounds of results, then an overflow on anything over ~5k chars.
    model = _Model(calls=3, overflow_over=5000)
    await _turn(_orchestrator(store, model, _settings(context_tokens=100_000), registry), sid, "the question")

    retried = model.windows[-1]
    assert retried[0].role == "system"
    assert retried[1].role == "user" and retried[1].content.endswith("the question")
    # No result without the call before it.
    seen: set[str] = set()
    for message in retried:
        for call in message.tool_calls:
            seen.add(call.id)
        if message.role == "tool":
            assert message.tool_call_id in seen


# -- costing and stability --------------------------------------------------------


def test_history_is_costed_by_what_is_sent(store: Store):
    sid = store.create_session()["id"]
    store.add_message(sid, "user", "first")
    reply = store.add_message(sid, "assistant", "short answer")
    # A turn that thought for a long time: its stored count is the reasoning,
    # which is never replayed.
    store.update_message(reply.id, "short answer", tokens=50_000)
    store.add_message(sid, "user", "second")
    orch = _orchestrator(store, _Model())
    window = orch.build_window(store.list_messages(sid), {}, system="S", session_id=sid)
    assert [m.content for m in window[1:]] == ["first", "short answer", "second"]


def test_the_facts_in_a_prompt_hold_for_the_conversation(store: Store):
    orch = _orchestrator(store, _Model())
    sid = store.create_session()["id"]
    kept = store.add_fact("The user's dog is called Bess.")
    before, _ = orch.build_system_prompt(sid)

    # Learned later (by the curation pass, say): not added mid-conversation.
    store.add_fact("The user prefers tea.")
    during, _ = orch.build_system_prompt(sid)
    assert during == before
    # But a new conversation gets it.
    assert "tea" in orch.build_system_prompt(store.create_session()["id"])[0]

    # And a fact forgotten leaves at once.
    store.delete_fact(kept.id)
    after, _ = orch.build_system_prompt(sid)
    assert "Bess" not in after


def test_the_project_listing_is_read_once_per_conversation(store: Store, tmp_path: Path):
    root = tmp_path / "app"
    root.mkdir()
    (root / "a.py").write_text("")
    orch = _orchestrator(store, _Model())
    first = orch._project_summary("s1", root)
    (root / "b.py").write_text("")
    assert orch._project_summary("s1", root) == first
    assert "b.py" in orch._project_summary("s2", root)
    # Changing the project's instructions is read at once.
    (root / "CLAUDE.md").write_text("Use tabs.")
    assert "Use tabs." in orch._project_summary("s1", root)
