"""Scheduled tasks, as three skills the assistant can call.

Split by verb for the same reason the calendar is: the model chooses from the
names alone, and a wrong name is one it can be told does not exist, where a
wrong `action` on one skill is a silent no-op. Nothing takes an id -- a task is
named the way the user named it, and an ambiguous name is a question asked back
rather than a guess.

A task is a *prompt*, not a reminder: when its time comes the assistant is run
on that prompt in a new conversation, with all its usual skills. So `prompt` has
to make sense read cold, by a model that was not in this conversation -- the
description says so, because "do that thing we discussed" is the natural way to
write it and the one that fails.
"""

from __future__ import annotations

import time

from ..schedule import (
    REPEATS, describe_when, first_run_ms, next_run_ms, parse_local, zone_for,
)
from ..situation import Situation
from ..store import Store, StoredTask
from .skill import NOT_CODE, Skill

MAX_LISTED = 40


def _describe(task: StoredTask) -> str:
    zone = zone_for(task.tz, task.utc_offset)
    if not task.enabled:
        when = "paused"
    elif task.next_run_at is None:
        when = "finished"
    else:
        when = "next " + describe_when(task.next_run_at, zone)
    repeat = "" if task.repeat == "once" else f", {task.repeat}"
    line = f"{task.title} — {when}{repeat}"
    if task.last_status and task.last_status != "running":
        line += f" (last run: {task.last_status})"
    return line


class ScheduleTask(Skill):
    modes = NOT_CODE
    wants_context = True
    wants_session = True

    def __init__(self, store: Store) -> None:
        super().__init__(
            name="schedule_task",
            description=(
                "Schedule something for the assistant to do later, on its own, "
                "at a time the user gives -- once or repeating. When the time "
                "comes it runs `prompt` in a fresh conversation, with the usual "
                "skills, and the result is saved in the conversation list. Use "
                "it for 'every morning at 8, summarise...' or 'tomorrow at 3pm, "
                "check...'. For a plain reminder or an event the user wants to "
                "see on their calendar, use the calendar instead. Times are the "
                "user's own local time. Check the date with current_time first "
                "if they said something relative like 'tomorrow' or 'in an hour'."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Short name the user can refer to it by.",
                    },
                    "prompt": {
                        "type": "string",
                        "description": (
                            "What to do, written as a complete instruction. It "
                            "runs in a new conversation that cannot see this "
                            "one, so include every detail it needs -- never "
                            "'do that thing we discussed'."
                        ),
                    },
                    "when": {
                        "type": "string",
                        "description": (
                            "First (or only) run, local time, YYYY-MM-DDTHH:MM."
                        ),
                    },
                    "repeat": {
                        "type": "string",
                        "enum": list(REPEATS),
                        "description": (
                            "How often it repeats from `when`. Defaults to "
                            "'once'. 'weekdays' is Monday to Friday."
                        ),
                    },
                },
                "required": ["title", "prompt", "when"],
            },
        )
        self.store = store

    async def use(
        self,
        title: str,
        prompt: str,
        when: str,
        repeat: str = "once",
        context: Situation | None = None,
        session: str | None = None,
    ) -> str:
        # A task that schedules tasks is a loop nobody asked for.
        if self.store.is_scheduled_session(session):
            return (
                "This conversation is itself a scheduled run, so it cannot "
                "schedule more tasks. Tell the user what should be scheduled."
            )
        title, prompt = (title or "").strip(), (prompt or "").strip()
        if not title or not prompt:
            return "A task needs both a title and a prompt."
        repeat = (repeat or "once").strip().lower()
        if repeat not in REPEATS:
            return f"{repeat!r} is not a repeat I know. Use one of: {', '.join(REPEATS)}."
        if parse_local(when) is None:
            return (
                f"{when!r} is not a time I can use. Write the local time as "
                "YYYY-MM-DDTHH:MM."
            )

        situation = context or Situation()
        zone = zone_for(situation.timezone, situation.utc_offset)
        now = int(time.time() * 1000)
        first = first_run_ms(when, repeat, zone, now)
        if first is None:
            return (
                f"{when} has already passed. Check the current time and give a "
                "time that is still ahead."
            )
        # A repeating task whose anchor is in the past still has a next run, but
        # that is almost always a wrong date rather than what was meant.
        if repeat != "once" and first != next_run_ms(when, "once", zone, 0):
            note = " (the start time was in the past, so it begins at the next occurrence)"
        else:
            note = ""

        task = self.store.add_task(
            title, prompt, when,
            repeat=repeat,
            tz=situation.timezone,
            utc_offset=situation.utc_offset,
            next_run_at=first,
            origin_session_id=session,
        )
        return f"Scheduled: {_describe(task)}{note}"


class ListScheduledTasks(Skill):
    modes = NOT_CODE

    def __init__(self, store: Store) -> None:
        super().__init__(
            name="list_scheduled_tasks",
            description=(
                "The tasks scheduled to run on their own, soonest first, with "
                "when each next runs and how its last run went. Use before "
                "answering anything about what is scheduled."
            ),
        )
        self.store = store

    async def use(self) -> str:
        tasks = self.store.list_tasks()
        if not tasks:
            return "Nothing is scheduled."
        out = "\n".join(_describe(t) for t in tasks[:MAX_LISTED])
        if len(tasks) > MAX_LISTED:
            out += f"\n… and {len(tasks) - MAX_LISTED} more."
        return out


class CancelScheduledTask(Skill):
    modes = NOT_CODE

    def __init__(self, store: Store) -> None:
        super().__init__(
            name="cancel_scheduled_task",
            description=(
                "Cancel a scheduled task, by its title as list_scheduled_tasks "
                "shows it. Set pause=true to switch it off without deleting it."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "The task's title."},
                    "pause": {
                        "type": "boolean",
                        "description": "Pause instead of deleting. Defaults to false.",
                    },
                },
                "required": ["title"],
            },
        )
        self.store = store

    async def use(self, title: str, pause: bool = False) -> str:
        needle = (title or "").strip().lower()
        if not needle:
            return "cancel_scheduled_task needs the title of the task."
        tasks = self.store.list_tasks()
        exact = [t for t in tasks if t.title.lower() == needle]
        found = exact or [t for t in tasks if needle in t.title.lower()]
        if not found:
            return f"No scheduled task matches {title!r}."
        if len(found) > 1:
            names = "; ".join(_describe(t) for t in found[:5])
            return f"More than one task matches {title!r}: {names}. Which one?"

        task = found[0]
        if pause:
            self.store.update_task(task.id, {"enabled": False})
            return f"Paused: {task.title}"
        self.store.delete_task(task.id)
        return f"Cancelled: {task.title}"
