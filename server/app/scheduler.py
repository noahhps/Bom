"""Runs scheduled tasks when their time comes.

One loop, one job: every few seconds ask the store what is due, and for each
task open a conversation and run its prompt through the same `run_turn` a
person's message goes through. Nothing here is a second way of talking to the
model -- a scheduled run has the same skills, memory, agent and provider
routing as a chat, and leaves the same kind of record behind, a conversation
in the list. That is deliberate: what a task did should be readable in the
place everything else the assistant did is readable.

Three decisions are worth knowing about:

* **advance before running.** A due task's `next_run_at` is moved on to its
  next occurrence *before* the turn starts, so a crash or a restart mid-run
  cannot run it twice, and a slow run cannot be picked up again by the next
  tick;

* **no one is watching.** A turn normally stops to ask -- "may this skill
  run?", "which design?". Nobody is there to answer, and waiting the full
  timeout would hold a run open for minutes. Approvals are refused at once
  (the skill still runs if the reader has said "always"), and a design question
  takes its default. Something that needs a yes should be granted before it is
  scheduled, not on a night it cannot be asked;

* **a missed run is not made up at any cost.** A server that was off at 09:00
  and starts at 09:20 should run the 09:00 task. One that starts three days
  later should not send a "good morning" briefing about last Tuesday. Past
  `GRACE_MS` the occurrence is recorded as missed and the task moves on.
"""

from __future__ import annotations

import asyncio
import json
import time

from .approvals import DENY
from .orchestrator import Orchestrator
from .schedule import next_run_ms, zone_for
from .situation import Situation
from .store import Store, StoredTask

#: How long past its time a task may still run.
GRACE_MS = 6 * 60 * 60 * 1000

#: How long one run may take before it is abandoned.
RUN_TIMEOUT_SECONDS = 15 * 60

#: How much of the reply is kept on the task, for the list.
SUMMARY_CHARS = 400

# Said to the model ahead of the task's own prompt. The prompt was written
# earlier, often in a different conversation, so "this" and "here" in it mean
# nothing now; and nobody is there to answer a question.
_PREFACE = (
    "[Scheduled task \"{title}\". This is running automatically at the time the "
    "user set, and they are not watching. Do the task now and report the "
    "result. Do not ask questions or wait for confirmation; if something is "
    "missing, say what and finish what you can. Do not schedule further tasks.]"
    "\n\n"
)


class Scheduler:
    def __init__(
        self, store: Store, orchestrator: Orchestrator, *, poll_seconds: float = 15.0
    ) -> None:
        self.store = store
        self.orchestrator = orchestrator
        self.poll_seconds = poll_seconds
        self._active: set[str] = set()  # task ids with a run in flight
        self._runs: set[asyncio.Task] = set()  # held so they are not collected mid-run

    # -- the loop ---------------------------------------------------------

    async def run_forever(self) -> None:
        while True:
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # one bad tick must not end the scheduler
                print(f"[scheduler] tick: {exc}")
            await asyncio.sleep(self.poll_seconds)

    async def tick(self, now_ms: int | None = None) -> list[str]:
        """Start every task that is due. Returns the ids started.

        Starting is all it waits for: the runs themselves continue in the
        background (see `wait_idle` for tests).
        """
        now = int(time.time() * 1000) if now_ms is None else now_ms
        started: list[str] = []
        for task in self.store.due_tasks(now):
            zone = zone_for(task.tz, task.utc_offset)
            following = next_run_ms(task.starts_at, task.repeat, zone, now)
            overdue = now - (task.next_run_at or now)

            if overdue > GRACE_MS:
                self.store.update_task(
                    task.id,
                    {"next_run_at": following, "last_status": "missed",
                     "last_summary": "The server was not running at the scheduled time."},
                )
                continue
            if task.id in self._active:
                # Still on its previous run (an hourly task that takes longer
                # than an hour). Skipped rather than stacked.
                self.store.update_task(task.id, {"next_run_at": following})
                continue

            self.store.update_task(task.id, {"next_run_at": following})
            self._spawn(task.id)
            started.append(task.id)
        return started

    def run_now(self, task_id: str) -> bool:
        """Run a task immediately, leaving its schedule alone. False if unknown
        or already running."""
        if self.store.get_task(task_id) is None or task_id in self._active:
            return False
        self._spawn(task_id)
        return True

    async def wait_idle(self) -> None:
        while self._runs:
            await asyncio.gather(*list(self._runs), return_exceptions=True)

    async def shutdown(self) -> None:
        """Stop every run and wait for it to finish unwinding.

        Waited on, not just cancelled: a cancelled run still records how it
        ended, and that has to happen before the database is closed.
        """
        runs = list(self._runs)
        for run in runs:
            run.cancel()
        await asyncio.gather(*runs, return_exceptions=True)

    # -- one run ----------------------------------------------------------

    def _spawn(self, task_id: str) -> None:
        self._active.add(task_id)
        run = asyncio.create_task(self._run(task_id))
        self._runs.add(run)
        run.add_done_callback(self._runs.discard)

    async def _run(self, task_id: str) -> None:
        try:
            task = self.store.get_task(task_id)
            if task is None:
                return
            status, summary = "error", "The run did not start."
            session_id: str | None = None
            try:
                session_id = self._open_session(task)
                self.store.update_task(
                    task.id, {"last_session_id": session_id, "last_status": "running",
                              "last_run_at": int(time.time() * 1000)},
                )
                self.orchestrator.live.add(session_id)
                try:
                    status, summary = await asyncio.wait_for(
                        self._drive(task, session_id), RUN_TIMEOUT_SECONDS
                    )
                finally:
                    self.orchestrator.live.discard(session_id)
            except asyncio.TimeoutError:
                status, summary = "error", "The run took too long and was stopped."
            except asyncio.CancelledError:
                status, summary = "error", "The server stopped during the run."
                raise
            except Exception as exc:  # noqa: BLE001 -- recorded, not raised
                status, summary = "error", f"{type(exc).__name__}: {exc}"
            finally:
                # The task may have been deleted while it ran.
                current = self.store.get_task(task_id)
                if current is not None:
                    self.store.update_task(
                        task_id,
                        {"last_status": status,
                         "last_summary": summary[:SUMMARY_CHARS] or None,
                         "run_count": current.run_count + 1},
                    )
        finally:
            self._active.discard(task_id)

    def _open_session(self, task: StoredTask) -> str:
        """Where a run happens: the agent's one conversation, for an agent's
        task -- so a reminder from the Secretary arrives where you talk to the
        Secretary -- and otherwise a conversation of its own.

        An agent's conversation that is answering something when the task
        comes due is left alone, and the run gets a conversation of its own
        rather than talking over it.
        """
        agent = self.store.get_agent(task.agent_id) if task.agent_id else None
        if agent:
            own = self.store.agent_conversation(agent.id)
            if own and own not in self.orchestrator.live:
                return own
        situation = Situation(timezone=task.tz, utc_offset=task.utc_offset)
        session = self.store.create_session(title=task.title, situation=situation)
        if agent:
            self.store.set_session_agent(session["id"], agent.id)
        return session["id"]

    async def _drive(self, task: StoredTask, session_id: str) -> tuple[str, str]:
        """Play the turn through, answering its questions on nobody's behalf."""
        text: list[str] = []
        failure: str | None = None
        message = _PREFACE.format(title=task.title) + task.prompt

        async for frame in self.orchestrator.run_turn(session_id, message):
            event, data = _parse(frame)
            if event == "delta":
                text.append(data.get("text", ""))
            elif event == "replace":
                text = [data.get("text", "")]
            elif event == "skill_approval":
                self.orchestrator.approvals.resolve(data.get("id", ""), DENY)
            elif event == "design_choice":
                # Wait would resolve to the default after its timeout; taking it
                # now is the same answer without the wait.
                self.orchestrator.choices.resolve(data.get("id", ""), "none")
            elif event == "error":
                failure = data.get("message") or "The turn failed."

        if failure:
            return "error", failure
        return "ok", "".join(text).strip()


def _parse(frame: str) -> tuple[str, dict]:
    event, payload = "", ""
    for line in frame.splitlines():
        if line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            payload += line[5:].strip()
    try:
        data = json.loads(payload) if payload else {}
    except ValueError:
        data = {}
    return event, data if isinstance(data, dict) else {}
