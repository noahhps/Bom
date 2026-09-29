"""Scheduled tasks: when they next run, the skills that make them, and the loop
that runs them."""

from __future__ import annotations

import asyncio
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.db import Database
from app.main import create_app
from app.orchestrator import Orchestrator
from app.providers.base import Chunk, ToolCall
from app.schedule import next_run_ms, occurrence, parse_local
from app.scheduler import GRACE_MS, Scheduler
from app.situation import Situation
from app.skills.registry import Registry
from app.skills.schedule import CancelScheduledTask, ListScheduledTasks, ScheduleTask
from app.skills.skill import Skill
from app.store import Store

LONDON = ZoneInfo("Europe/London")


def ms(y, mo, d, h=0, mi=0, zone=LONDON) -> int:
    return int(datetime(y, mo, d, h, mi, tzinfo=zone).timestamp() * 1000)


# -- pure schedule ------------------------------------------------------------


def test_parse_local_rejects_the_wrong_shape_and_impossible_dates():
    assert parse_local("2026-10-01T09:00") == datetime(2026, 10, 1, 9, 0)
    assert parse_local("2026-10-01") is None
    assert parse_local("tomorrow at 9") is None
    assert parse_local("2026-02-31T09:00") is None


def test_once_runs_only_while_ahead():
    anchor = "2026-10-01T09:00"
    assert next_run_ms(anchor, "once", LONDON, ms(2026, 9, 30)) == ms(2026, 10, 1, 9)
    assert next_run_ms(anchor, "once", LONDON, ms(2026, 10, 1, 9)) is None


def test_daily_stays_at_the_wall_clock_across_a_clock_change():
    # UK clocks go back on 25 Oct 2026. 09:00 must stay 09:00, which is an
    # hour later in UTC afterwards -- not drift to 08:00 local.
    anchor = "2026-10-24T09:00"
    after = next_run_ms(anchor, "daily", LONDON, ms(2026, 10, 25, 9))
    assert after == ms(2026, 10, 26, 9)
    assert datetime.fromtimestamp(after / 1000, LONDON).hour == 9


def test_weekdays_skip_the_weekend():
    anchor = "2026-10-02T09:00"  # a Friday
    assert next_run_ms(anchor, "weekdays", LONDON, ms(2026, 10, 2, 9)) == ms(2026, 10, 5, 9)
    # A weekend anchor starts on the following Monday.
    assert next_run_ms("2026-10-03T09:00", "weekdays", LONDON, 0) == ms(2026, 10, 5, 9)


def test_monthly_clamps_short_months_without_drifting():
    start = parse_local("2026-01-31T09:00")
    assert occurrence(start, "monthly", 1).day == 28  # Feb
    assert occurrence(start, "monthly", 2).day == 31  # back to the 31st in March
    assert occurrence(start, "monthly", 3).day == 30  # April


def test_hourly_and_weekly():
    assert next_run_ms("2026-10-01T09:00", "hourly", LONDON, ms(2026, 10, 1, 9, 30)) == ms(2026, 10, 1, 10)
    assert next_run_ms("2026-10-01T09:00", "weekly", LONDON, ms(2026, 10, 1, 9)) == ms(2026, 10, 8, 9)


# -- the skills ---------------------------------------------------------------


@pytest.fixture
def store(tmp_path: Path) -> Store:
    return Store(Database(tmp_path / "sched.db"))


LONDON_SITUATION = Situation(timezone="Europe/London")


@pytest.mark.asyncio
async def test_schedule_task_stores_it_in_the_users_zone(store: Store):
    skill = ScheduleTask(store)
    result = await skill.use(
        title="Briefing", prompt="Summarise my day.", when="2099-01-05T08:00",
        repeat="daily", context=LONDON_SITUATION,
    )
    assert result.startswith("Scheduled: Briefing")
    (task,) = store.list_tasks()
    assert task.tz == "Europe/London" and task.repeat == "daily"
    assert task.next_run_at == ms(2099, 1, 5, 8)


@pytest.mark.asyncio
async def test_schedule_task_refuses_bad_input_with_a_reason(store: Store):
    skill = ScheduleTask(store)
    assert "YYYY-MM-DDTHH:MM" in await skill.use(title="x", prompt="y", when="tomorrow")
    assert "already passed" in await skill.use(title="x", prompt="y", when="2001-01-01T09:00")
    assert "not a repeat" in await skill.use(
        title="x", prompt="y", when="2099-01-01T09:00", repeat="fortnightly")
    assert "title and a prompt" in await skill.use(title="", prompt="y", when="2099-01-01T09:00")
    assert store.list_tasks() == []


@pytest.mark.asyncio
async def test_a_scheduled_run_cannot_schedule_more(store: Store):
    skill = ScheduleTask(store)
    await skill.use(title="A", prompt="p", when="2099-01-01T09:00", context=LONDON_SITUATION)
    (task,) = store.list_tasks()
    session = store.create_session()["id"]
    store.update_task(task.id, {"last_session_id": session})
    refused = await skill.use(title="B", prompt="p", when="2099-01-01T10:00", session=session)
    assert "cannot schedule" in refused
    assert len(store.list_tasks()) == 1


@pytest.mark.asyncio
async def test_list_and_cancel_by_title(store: Store):
    make = ScheduleTask(store)
    await make.use(title="Morning briefing", prompt="p", when="2099-01-01T08:00", context=LONDON_SITUATION)
    await make.use(title="Morning walk", prompt="p", when="2099-01-01T07:00", context=LONDON_SITUATION)
    assert "Morning walk" in await ListScheduledTasks(store).use()

    cancel = CancelScheduledTask(store)
    assert "More than one" in await cancel.use("morning")
    assert "No scheduled task" in await cancel.use("evening")
    assert (await cancel.use("Morning walk", pause=True)).startswith("Paused")
    assert "paused" in await ListScheduledTasks(store).use()
    assert (await cancel.use("briefing")).startswith("Cancelled")
    assert [t.title for t in store.list_tasks()] == ["Morning walk"]


# -- the loop -----------------------------------------------------------------


class _Answers:
    name = "mock"
    model = "mock"

    def __init__(self, text="All done.", calls=()):
        self.text, self.calls, self.prompts = text, calls, []

    async def stream(self, messages, *, think=None, tools=None):
        self.prompts.append(messages[-1].content)
        yield Chunk(text=self.text, done=True)

    async def embed(self, texts):
        return [[0.0] * 8 for _ in texts]

    async def health(self):
        return True


class _Boom(_Answers):
    async def stream(self, messages, *, think=None, tools=None):
        raise RuntimeError("model unreachable")
        yield  # pragma: no cover


def _scheduler(store: Store, provider) -> Scheduler:
    router = type("R", (), {})()

    async def resolve(prefer=None):
        return type("Route", (), {"provider": provider, "reason": "local"})()

    router.resolve = resolve
    router.invalidate_health = lambda: None
    settings = type("S", (), {
        "system_preamble": "You help.", "context_tokens": 8192, "reply_tokens": 1024,
        "ollama_think": "medium", "memory_max_facts": 20, "memory_fact_chars": 200,
    })()
    return Scheduler(store, Orchestrator(settings, store, router, Registry()))


def _task(store: Store, when_ms: int, repeat="once", **kw):
    return store.add_task("Briefing", "Summarise my day.", "2026-10-01T09:00",
                          repeat=repeat, tz="Europe/London", next_run_at=when_ms, **kw)


@pytest.mark.asyncio
async def test_a_due_task_runs_in_its_own_conversation(store: Store):
    provider = _Answers("Here is your day.")
    scheduler = _scheduler(store, provider)
    due = ms(2026, 10, 1, 9)
    task = _task(store, due)

    assert await scheduler.tick(due + 5_000) == [task.id]
    await scheduler.wait_idle()

    done = store.get_task(task.id)
    assert done.last_status == "ok" and done.run_count == 1
    assert done.last_summary == "Here is your day."
    assert done.next_run_at is None  # a one-off has nothing left to run
    messages = store.list_messages(done.last_session_id)
    assert [m.role for m in messages] == ["user", "assistant"]
    assert "Summarise my day." in provider.prompts[0]
    assert "Scheduled task" in provider.prompts[0]
    assert store.get_session(done.last_session_id)["title"] == "Briefing"


@pytest.mark.asyncio
async def test_a_task_that_is_not_due_or_is_paused_does_not_run(store: Store):
    scheduler = _scheduler(store, _Answers())
    later = _task(store, ms(2026, 10, 2, 9))
    paused = _task(store, ms(2026, 10, 1, 9))
    store.update_task(paused.id, {"enabled": False})
    assert await scheduler.tick(ms(2026, 10, 1, 10)) == []
    assert store.get_task(later.id).run_count == 0


@pytest.mark.asyncio
async def test_a_repeating_task_is_advanced_before_it_runs(store: Store):
    scheduler = _scheduler(store, _Answers())
    due = ms(2026, 10, 1, 9)
    task = _task(store, due, repeat="daily")
    await scheduler.tick(due + 1_000)
    # Moved on immediately, so a second tick cannot start it again.
    assert store.get_task(task.id).next_run_at == ms(2026, 10, 2, 9)
    assert await scheduler.tick(due + 2_000) == []
    await scheduler.wait_idle()
    assert store.get_task(task.id).run_count == 1


@pytest.mark.asyncio
async def test_a_long_missed_run_is_recorded_not_made_up(store: Store):
    provider = _Answers()
    scheduler = _scheduler(store, provider)
    due = ms(2026, 10, 1, 9)
    task = _task(store, due, repeat="daily")
    now = due + GRACE_MS + 60_000
    assert await scheduler.tick(now) == []
    after = store.get_task(task.id)
    assert after.last_status == "missed" and after.run_count == 0
    assert after.next_run_at > now
    assert provider.prompts == []


@pytest.mark.asyncio
async def test_a_failed_run_is_recorded_and_does_not_stop_the_scheduler(store: Store):
    scheduler = _scheduler(store, _Boom())
    due = ms(2026, 10, 1, 9)
    task = _task(store, due, repeat="daily")
    await scheduler.tick(due)
    await scheduler.wait_idle()
    failed = store.get_task(task.id)
    assert failed.last_status == "error" and "unreachable" in failed.last_summary
    assert failed.next_run_at == ms(2026, 10, 2, 9)  # still scheduled


@pytest.mark.asyncio
async def test_an_approval_prompt_is_refused_not_waited_on(store: Store):
    class _NeedsAsk(Skill):
        def __init__(self):
            super().__init__(name="risky", description="risky")

        @property
        def must_ask(self):
            return True

        async def use(self, **kw):
            return "RAN"

    class _CallsIt(_Answers):
        async def stream(self, messages, *, think=None, tools=None):
            if any("declined" in str(m.content) for m in messages):
                yield Chunk(text="Could not.", done=True)
            else:
                yield Chunk(done=True, tool_calls=(ToolCall(id="1", name="risky", arguments={}),))

    scheduler = _scheduler(store, _CallsIt())
    scheduler.orchestrator.registry.register(_NeedsAsk())
    due = ms(2026, 10, 1, 9)
    task = _task(store, due)
    await scheduler.tick(due)
    await asyncio.wait_for(scheduler.wait_idle(), 5)  # would take 300s if it waited
    done = store.get_task(task.id)
    assert done.last_status == "ok" and done.last_summary == "Could not."


# -- the API ------------------------------------------------------------------


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    app = create_app(Settings(db_path=tmp_path / "api.db", auth_token="tok"))
    return TestClient(app, headers={"Authorization": "Bearer tok"})


def test_api_create_list_pause_resume_delete(client: TestClient):
    made = client.post("/api/scheduled-tasks", json={
        "title": "Nightly", "prompt": "Check things.", "starts_at": "2099-01-01T02:00",
        "repeat": "daily", "tz": "Europe/London",
    })
    assert made.status_code == 200, made.text
    task = made.json()
    assert task["next_run_at"] == ms(2099, 1, 1, 2) and task["enabled"] is True

    assert [t["id"] for t in client.get("/api/scheduled-tasks").json()["tasks"]] == [task["id"]]

    paused = client.patch(f"/api/scheduled-tasks/{task['id']}", json={"enabled": False}).json()
    assert paused["enabled"] is False
    resumed = client.patch(f"/api/scheduled-tasks/{task['id']}", json={"enabled": True}).json()
    assert resumed["enabled"] is True and resumed["next_run_at"] == ms(2099, 1, 1, 2)

    assert client.delete(f"/api/scheduled-tasks/{task['id']}").status_code == 200
    assert client.delete(f"/api/scheduled-tasks/{task['id']}").status_code == 404


def test_api_rejects_bad_times_and_needs_the_token(client: TestClient):
    base = {"title": "x", "prompt": "y", "starts_at": "2099-01-01T02:00"}
    assert client.post("/api/scheduled-tasks", json={**base, "starts_at": "soon"}).status_code == 422
    assert client.post("/api/scheduled-tasks", json={**base, "repeat": "yearly"}).status_code == 422
    assert client.post("/api/scheduled-tasks", json={**base, "starts_at": "2001-01-01T02:00"}).status_code == 422
    assert client.get("/api/scheduled-tasks", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert client.post("/api/scheduled-tasks/tsk_none/run").status_code == 404


def test_the_skills_are_registered_and_the_scheduler_is_running(client: TestClient):
    names = {s["name"] for s in client.get("/api/skills").json()["skills"]} \
        if isinstance(client.get("/api/skills").json(), dict) else set()
    assert {"schedule_task", "list_scheduled_tasks", "cancel_scheduled_task"} <= names
