"""A small client for the Chrome DevTools Protocol.

Enough of it to drive a page: send a command and wait for its reply, hear
events, and tell which page an event came from. A browser session is one
WebSocket carrying every page's traffic, with each page's commands and events
tagged by the `sessionId` the browser handed out when the page was attached
("flat" mode, which every current Chromium speaks).

No dependency beyond `websockets`, which the relay already brought in. The
whole protocol is JSON with an `id` on every command and the same `id` on its
reply; this is the forty lines that match them up.
"""

from __future__ import annotations

import asyncio
import itertools
import json
from collections.abc import Callable

from websockets.asyncio.client import connect as ws_connect

#: How long a command may wait for its reply before the call gives up. A
#: screenshot of a heavy page takes a second or two; nothing takes thirty.
COMMAND_TIMEOUT = 30.0

Listener = Callable[[str, dict, str | None], None]


class CDPError(RuntimeError):
    """The browser refused a command, or the connection to it is gone."""


class CDP:
    def __init__(self, url: str, *, timeout: float = COMMAND_TIMEOUT) -> None:
        self.url = url
        self.timeout = timeout
        self._ws = None
        self._ids = itertools.count(1)
        self._pending: dict[int, asyncio.Future] = {}
        self._listeners: list[Listener] = []
        self._reader: asyncio.Task | None = None
        self.closed = asyncio.Event()

    async def connect(self) -> None:
        # No size cap: a screenshot comes back as one frame of base64, and a
        # page's text can be large. No keepalive pings: Chromium answers them,
        # but a long command (a slow page's screenshot) would otherwise be
        # mistaken for a dead connection.
        self._ws = await ws_connect(
            self.url, max_size=None, open_timeout=self.timeout, ping_interval=None
        )
        self._reader = asyncio.create_task(self._read())

    @property
    def connected(self) -> bool:
        return self._ws is not None and not self.closed.is_set()

    async def _read(self) -> None:
        try:
            async for raw in self._ws:
                try:
                    message = json.loads(raw)
                except ValueError:
                    continue
                if "id" in message:
                    future = self._pending.pop(message["id"], None)
                    if future is None or future.done():
                        continue
                    error = message.get("error")
                    if error:
                        future.set_exception(CDPError(error.get("message") or "the browser refused"))
                    else:
                        future.set_result(message.get("result") or {})
                elif "method" in message:
                    for listener in list(self._listeners):
                        try:
                            listener(message["method"], message.get("params") or {}, message.get("sessionId"))
                        except Exception:  # noqa: BLE001 -- one listener's bug is not another's
                            pass
        except Exception:  # noqa: BLE001 -- any close reason ends the same way
            pass
        finally:
            self.closed.set()
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(CDPError("the browser connection closed"))
            self._pending.clear()

    async def send(
        self, method: str, params: dict | None = None, *, session_id: str | None = None,
        timeout: float | None = None,
    ) -> dict:
        """One command, and its reply."""
        if not self.connected:
            raise CDPError("not connected to the browser")
        message_id = next(self._ids)
        message: dict = {"id": message_id, "method": method, "params": params or {}}
        if session_id:
            message["sessionId"] = session_id
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[message_id] = future
        try:
            await self._ws.send(json.dumps(message))
            return await asyncio.wait_for(future, timeout or self.timeout)
        except (asyncio.TimeoutError, TimeoutError):
            self._pending.pop(message_id, None)
            raise CDPError(f"{method} did not answer in time") from None

    def listen(self, listener: Listener) -> Callable[[], None]:
        """Hear every event. Returns the function that stops listening."""
        self._listeners.append(listener)

        def off() -> None:
            try:
                self._listeners.remove(listener)
            except ValueError:
                pass

        return off

    async def wait_for(
        self, method: str, *, session_id: str | None = None, timeout: float,
        predicate: Callable[[dict], bool] | None = None,
    ) -> dict:
        """The next event of `method` (for one page, when `session_id` is given)."""
        future: asyncio.Future = asyncio.get_running_loop().create_future()

        def listener(name: str, params: dict, sid: str | None) -> None:
            if name != method or (session_id is not None and sid != session_id):
                return
            if predicate is not None and not predicate(params):
                return
            if not future.done():
                future.set_result(params)

        off = self.listen(listener)
        try:
            return await asyncio.wait_for(future, timeout)
        finally:
            off()

    async def close(self) -> None:
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:  # noqa: BLE001
                pass
        if self._reader is not None:
            self._reader.cancel()
            await asyncio.gather(self._reader, return_exceptions=True)
        self.closed.set()
