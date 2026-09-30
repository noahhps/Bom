"""One private broadcast channel on Supabase Realtime.

Just enough of the Phoenix channels protocol (v1, JSON frames) to join a single
private channel, send and receive broadcasts on it, keep the socket alive, and
hand the server a fresh token before the old one expires. Supabase's own Python
client does this too, but brings a dependency tree for four message types;
`websockets` is already here, pulled in by uvicorn.

The channel is private, so Realtime checks the joining token against the
access rules in relay/supabase/migrations on join and on every message sent --
a refused join surfaces here as `ChannelRefused`, not as a silent channel that
never receives anything.
"""

from __future__ import annotations

import asyncio
import itertools
import json
from typing import Any, Awaitable, Callable
from urllib.parse import urlencode

import websockets
from websockets.asyncio.client import connect as ws_connect

OnBroadcast = Callable[[str, dict[str, Any]], Awaitable[None]]

# Phoenix's own default, and what supabase-js uses.
HEARTBEAT_SECONDS = 25.0
JOIN_TIMEOUT = 15.0
# Supabase counts messages per second per project (100 on the free plan). The
# bridge coalesces a streaming reply into ~25 frames a second; this is the
# ceiling for everything together, so a burst queues rather than being dropped.
MAX_SENDS_PER_SECOND = 40.0
# Incoming frames: a request body arrives in parts of ~96 KB, so 4 MB is slack.
MAX_FRAME = 4 * 1024 * 1024


class ChannelRefused(Exception):
    """The server would not let this token onto the channel."""


class ChannelClosed(Exception):
    """The socket went away. Usually transient; the caller reconnects."""


def realtime_url(project_url: str, api_key: str) -> str:
    base = project_url.rstrip("/")
    if base.startswith("https://"):
        base = "wss://" + base[len("https://"):]
    elif base.startswith("http://"):
        base = "ws://" + base[len("http://"):]
    return f"{base}/realtime/v1/websocket?" + urlencode({"apikey": api_key, "vsn": "1.0.0"})


class RealtimeChannel:
    def __init__(
        self,
        project_url: str,
        api_key: str,
        topic: str,
        *,
        on_broadcast: OnBroadcast,
        connect: Callable[..., Any] = ws_connect,
    ) -> None:
        self._url = realtime_url(project_url, api_key)
        self.topic = "realtime:" + topic
        self._on_broadcast = on_broadcast
        self._connect = connect
        self._refs = itertools.count(1)
        self._join_ref: str | None = None
        self._ws: Any = None
        self._tasks: list[asyncio.Task] = []
        self._handlers: set[asyncio.Task] = set()
        self._closed: asyncio.Future | None = None
        self._join_reply: asyncio.Future | None = None
        self._heartbeat_pending: str | None = None
        self._send_lock = asyncio.Lock()
        self._last_send = 0.0

    # -- lifecycle -----------------------------------------------------------

    async def open(self, access_token: str) -> None:
        loop = asyncio.get_running_loop()
        self._closed = loop.create_future()
        self._join_reply = loop.create_future()
        self._ws = await self._connect(self._url, max_size=MAX_FRAME, open_timeout=JOIN_TIMEOUT)
        self._tasks = [
            asyncio.create_task(self._read(), name="realtime-read"),
            asyncio.create_task(self._heartbeat(), name="realtime-heartbeat"),
        ]
        self._join_ref = str(next(self._refs))
        await self._write(
            {
                "topic": self.topic,
                "event": "phx_join",
                "payload": {
                    "config": {
                        "broadcast": {"ack": False, "self": False},
                        "presence": {"key": "", "enabled": False},
                        "postgres_changes": [],
                        # The whole point: a private channel is checked
                        # against the access rules; a public one is not.
                        "private": True,
                    },
                    "access_token": access_token,
                },
                "ref": self._join_ref,
                "join_ref": self._join_ref,
            }
        )
        try:
            reply = await asyncio.wait_for(asyncio.shield(self._join_reply), JOIN_TIMEOUT)
        except (TimeoutError, asyncio.TimeoutError):
            await self.close()
            raise ChannelClosed("the relay did not answer the join")
        except BaseException:
            await self.close()
            raise
        if reply.get("status") != "ok":
            await self.close()
            response = reply.get("response") or {}
            reason = response.get("reason") or response.get("message") or json.dumps(response)
            raise ChannelRefused(str(reason))

    async def wait_closed(self) -> str:
        """Block until the channel ends; returns why."""
        assert self._closed is not None, "open() first"
        return await asyncio.shield(self._closed)

    async def close(self) -> None:
        self._finish("closed")
        for task in self._tasks:
            task.cancel()
        for task in list(self._handlers):
            task.cancel()
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:  # noqa: BLE001 -- already gone is fine
                pass

    # -- sending -------------------------------------------------------------

    async def send(self, event: str, payload: dict[str, Any]) -> None:
        if self._closed is None or self._closed.done():
            raise ChannelClosed("the channel is closed")
        await self._write(
            {
                "topic": self.topic,
                "event": "broadcast",
                "payload": {"type": "broadcast", "event": event, "payload": payload},
                "ref": str(next(self._refs)),
                "join_ref": self._join_ref,
            }
        )

    async def set_token(self, access_token: str) -> None:
        """Hand the server a fresh token before the current one expires."""
        await self._write(
            {
                "topic": self.topic,
                "event": "access_token",
                "payload": {"access_token": access_token},
                "ref": str(next(self._refs)),
                "join_ref": self._join_ref,
            }
        )

    async def _write(self, message: dict[str, Any]) -> None:
        # One frame at a time, paced: the lock keeps frames whole and in
        # order, the pacing keeps a burst under the project's rate limit.
        async with self._send_lock:
            loop = asyncio.get_running_loop()
            wait = self._last_send + 1.0 / MAX_SENDS_PER_SECOND - loop.time()
            if wait > 0:
                await asyncio.sleep(wait)
            try:
                await self._ws.send(json.dumps(message, separators=(",", ":")))
            except websockets.ConnectionClosed as exc:
                self._finish(f"socket closed: {exc}")
                raise ChannelClosed(str(exc)) from exc
            self._last_send = loop.time()

    # -- receiving -----------------------------------------------------------

    async def _read(self) -> None:
        try:
            async for raw in self._ws:
                try:
                    message = json.loads(raw)
                except (TypeError, ValueError):
                    continue
                self._dispatch(message)
            self._finish("socket closed by the relay")
        except websockets.ConnectionClosed as exc:
            self._finish(f"socket closed: {exc}")
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 -- anything else ends the channel too
            self._finish(f"read failed: {exc}")

    def _dispatch(self, message: dict[str, Any]) -> None:
        topic = message.get("topic")
        event = message.get("event")
        payload = message.get("payload") or {}
        ref = message.get("ref")

        if topic == "phoenix" and event == "phx_reply":
            if ref == self._heartbeat_pending:
                self._heartbeat_pending = None
            return
        if topic != self.topic:
            return
        if event == "phx_reply" and ref == self._join_ref:
            if self._join_reply is not None and not self._join_reply.done():
                self._join_reply.set_result(payload)
            return
        if event in ("phx_error", "phx_close"):
            self._finish(f"channel {event[4:]}")
            return
        if event == "system" and payload.get("status") == "error":
            # e.g. the token expired, or the access rules now say no.
            self._finish(str(payload.get("message") or "the relay closed the channel"))
            return
        if event == "broadcast" and isinstance(payload.get("payload"), dict):
            # Each broadcast in its own task, so a slow handler never holds up
            # the socket -- and the heartbeat replies behind it.
            task = asyncio.create_task(self._handle(str(payload.get("event")), payload["payload"]))
            self._handlers.add(task)
            task.add_done_callback(self._handlers.discard)

    async def _handle(self, event: str, payload: dict[str, Any]) -> None:
        try:
            await self._on_broadcast(event, payload)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 -- one bad message must not end the channel
            print(f"[remote] handling {event!r}: {exc}")

    async def _heartbeat(self) -> None:
        try:
            while True:
                await asyncio.sleep(HEARTBEAT_SECONDS)
                if self._heartbeat_pending is not None:
                    # The last one was never answered: the socket is dead
                    # even if TCP has not noticed yet.
                    self._finish("the relay stopped answering")
                    await self._ws.close()
                    return
                self._heartbeat_pending = str(next(self._refs))
                await self._write(
                    {"topic": "phoenix", "event": "heartbeat", "payload": {}, "ref": self._heartbeat_pending}
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            self._finish(f"heartbeat failed: {exc}")

    def _finish(self, reason: str) -> None:
        if self._join_reply is not None and not self._join_reply.done():
            self._join_reply.set_exception(ChannelClosed(reason))
            # Retrieved here so an unawaited failure is not logged as lost.
            self._join_reply.exception()
        if self._closed is not None and not self._closed.done():
            self._closed.set_result(reason)
