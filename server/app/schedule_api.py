"""The HTTP surface for scheduled tasks: list, create, edit, delete, run now.

The assistant makes tasks through the `schedule_task` skill; this is for a
screen that lists them, pauses them and deletes them, and for creating one
without a conversation.
"""

from __future__ import annotations

import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .schedule import REPEATS, first_run_ms, next_run_ms, parse_local, zone_for
from .scheduler import Scheduler
from .store import Store, StoredTask


class TaskIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    prompt: str = Field(min_length=1, max_length=50_000)
    # Local wall-clock time, YYYY-MM-DDTHH:MM, in `tz`.
    starts_at: str
    repeat: str = "once"
    tz: str | None = Field(default=None, max_length=64)
    utc_offset: int | None = Field(default=None, ge=-840, le=840)
    agent_id: str | None = None


class TaskPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    prompt: str | None = Field(default=None, min_length=1, max_length=50_000)
    starts_at: str | None = None
    repeat: str | None = None
    enabled: bool | None = None
    agent_id: str | None = None


def _check(starts_at: str, repeat: str) -> None:
    if repeat not in REPEATS:
        raise HTTPException(422, f"repeat must be one of {', '.join(REPEATS)}")
    if parse_local(starts_at) is None:
        raise HTTPException(422, "starts_at must be a local time, YYYY-MM-DDTHH:MM")


def build_schedule_router(store: Store, scheduler: Scheduler, auth) -> APIRouter:
    router = APIRouter(dependencies=[Depends(auth)])

    def _get(task_id: str) -> StoredTask:
        task = store.get_task(task_id)
        if task is None:
            raise HTTPException(404, "no such task")
        return task

    @router.get("/scheduled-tasks")
    def list_tasks() -> dict:
        return {"tasks": [t.to_dict() for t in store.list_tasks()]}

    @router.post("/scheduled-tasks")
    def create_task(body: TaskIn) -> dict:
        _check(body.starts_at, body.repeat)
        if body.agent_id and not store.get_agent(body.agent_id):
            raise HTTPException(404, "no such agent")
        zone = zone_for(body.tz, body.utc_offset)
        first = first_run_ms(body.starts_at, body.repeat, zone, int(time.time() * 1000))
        if first is None:
            raise HTTPException(422, "that time has already passed")
        task = store.add_task(
            body.title.strip(), body.prompt.strip(), body.starts_at,
            repeat=body.repeat, tz=body.tz, utc_offset=body.utc_offset,
            next_run_at=first, agent_id=body.agent_id,
        )
        return task.to_dict()

    @router.patch("/scheduled-tasks/{task_id}")
    def update_task(task_id: str, body: TaskPatch) -> dict:
        task = _get(task_id)
        changes = body.model_dump(exclude_unset=True)
        agent = changes.get("agent_id")
        if agent and not store.get_agent(agent):
            raise HTTPException(404, "no such agent")

        starts_at = changes.get("starts_at", task.starts_at)
        repeat = changes.get("repeat", task.repeat)
        _check(starts_at, repeat)
        enabled = changes.get("enabled", bool(task.enabled))

        # The next run follows the schedule whenever the schedule or the switch
        # changes -- resuming a paused task must not fire for a time that went
        # by while it was off.
        if {"starts_at", "repeat", "enabled"} & changes.keys():
            zone = zone_for(task.tz, task.utc_offset)
            changes["next_run_at"] = (
                next_run_ms(starts_at, repeat, zone, int(time.time() * 1000))
                if enabled else task.next_run_at
            )
        return store.update_task(task_id, changes).to_dict()  # type: ignore[union-attr]

    @router.delete("/scheduled-tasks/{task_id}")
    def delete_task(task_id: str) -> dict:
        if not store.delete_task(task_id):
            raise HTTPException(404, "no such task")
        return {"ok": True}

    @router.post("/scheduled-tasks/{task_id}/run", status_code=202)
    async def run_task(task_id: str) -> dict:
        # async: starting a run needs the server's event loop.
        _get(task_id)
        if not scheduler.run_now(task_id):
            raise HTTPException(409, "that task is already running")
        return {"ok": True}

    return router
