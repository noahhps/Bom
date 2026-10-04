"""This machine as a remote host: reachable from anywhere, through a relay.

The server usually sits behind a home router, where nothing can dial it. So it
dials out instead: it signs in to the relay (a Supabase project the user owns)
as its own device account, joins one private Realtime channel, and serves the
requests its owner's clients broadcast there. Each one is forwarded to this
server's own API over loopback -- the same routes, the same bearer token, the
same streaming -- and the reply is broadcast back in pieces.

Who can use it is decided in layers, each of which holds on its own:

1. **Consent at the device.** Remote access is off until someone turns it on
   *at this machine* -- the Settings switch only answers requests from this
   machine, and `./run.sh --remote` is run on it. A request that arrived
   through the relay can never turn it on, off, or re-link it.
2. **Pairing.** Turning it on shows a one-time code on this machine. It links
   the device only when typed into the web app by someone signed in -- so the
   account and the screen have to belong to the same person. The device gets
   a sign-in of its own; it never holds its owner's.
3. **The channel's access rules.** Realtime lets only the owner's account and
   the device's onto `bom:host:<id>`, a name only the owner can read.
4. **This file.** Every request carries the caller's own session token, and
   the device asks the auth server whose it is. Anyone but the owner gets a
   401 -- even if the rules above were misconfigured.
"""

from __future__ import annotations

import asyncio
import base64
import codecs
import hashlib
import json
import os
import platform
import re
import socket
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Callable

import httpx

from .realtime import ChannelClosed, ChannelRefused, RealtimeChannel
from .supabase import RelayError, Session, call_function, get_user, heartbeat, sign_in, token_expiry

# Set on every request the bridge forwards, so the routes that manage remote
# access can tell a relayed request from one made at this machine -- both
# arrive from 127.0.0.1.
RELAY_HEADER = "X-Bom-Relay"

# One broadcast carries at most this many bytes of body. Supabase's free plan
# caps a message at 256 KB; 96 KB leaves room for base64 and JSON escaping.
MAX_PART = 96 * 1024
# A request body may arrive in up to this many parts (~96 MB).
MAX_PARTS = 1024
# How long a streaming reply may gather bytes before they go out together.
COALESCE_SECONDS = 0.04
# While a reply has nothing to say, say that it is still alive this often, so
# the client can tell a long think from a vanished host.
KEEPALIVE_SECONDS = 15.0
# A request whose parts stop arriving for this long is dropped, and the
# caller told: a part was lost on the way.
PARTIAL_TIMEOUT = 30.0
MAX_INFLIGHT = 32
# A request body arriving in parts is acknowledged every this many parts, so
# the client can keep only a few in flight: on a slow uplink, a body sent all
# at once sits in the client's socket for minutes, starving the connection's
# heartbeats, while the client's clock for an answer is already running.
ACK_EVERY = 4
# What this end of the relay supports, told to the client in each pong.
# 2: acknowledges request parts (req-ack).
PROTOCOL = 2
# A caller's verified session is remembered at most this long.
CALLER_TTL = 300.0
# How many pairing codes may go unused in a row before remote access gives up
# and turns itself back off.
MAX_UNUSED_CODES = 3

ALLOWED_METHODS = frozenset(("GET", "POST", "PUT", "PATCH", "DELETE"))
# Routes a relayed request may never reach, whoever it is from.
DENIED_ROUTES = ("/remote", "/terminal")
PASSED_HEADERS = ("content-type", "content-disposition")

_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


@dataclass
class Link:
    """What pairing gave this device: its sign-in, and whose it is."""

    host_id: str
    host_name: str
    owner_id: str
    owner_email: str
    device_email: str
    device_password: str


def loopback_origin(settings: Any) -> str:
    """Where this server can reach its own API."""
    host = str(settings.bind_host or "")
    if host in ("", "0.0.0.0", "localhost"):
        host = "127.0.0.1"
    elif host in ("::", "[::]"):
        host = "::1"
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    return f"http://{host}:{settings.bind_port}"


def clean_path(path: Any) -> str | None:
    """A relayed path, if it is one this bridge will forward. Only ever
    appended to `/api` on loopback, but checked as though it were hostile."""
    if not isinstance(path, str) or not path.startswith("/") or path.startswith("//"):
        return None
    if len(path) > 8192 or any(c in path for c in "\\#\r\n\t\0 "):
        return None
    route = path.split("?", 1)[0]
    lowered = route.lower()
    if "%2e" in lowered or "%2f" in lowered or "%5c" in lowered:
        return None
    if any(segment in (".", "..") for segment in route.split("/")):
        return None
    return path


def denied(path: str) -> bool:
    route = path.split("?", 1)[0].rstrip("/")
    return any(route == d or route.startswith(d + "/") for d in DENIED_ROUTES)


def textual(content_type: str) -> bool:
    kind = content_type.split(";", 1)[0].strip().lower()
    return (
        kind.startswith("text/")
        or kind in ("application/json", "application/javascript", "application/xml", "image/svg+xml")
        or kind.endswith("+json")
    )


def device_name(settings: Any) -> str:
    name = str(getattr(settings, "remote_name", "") or "").strip()
    if not name:
        name = socket.gethostname().split(".")[0] or "Bom host"
    return name[:80]


def platform_name() -> str:
    system = platform.system()
    return {"Darwin": "macOS"}.get(system, system) or "unknown"


class RemoteHost:
    def __init__(
        self,
        settings: Any,
        *,
        local_http: httpx.AsyncClient | None = None,
        relay_http: httpx.AsyncClient | None = None,
        channel_factory: Callable[..., Any] = RealtimeChannel,
        announce: Callable[[str], None] | None = None,
    ) -> None:
        self._settings = settings
        self._file: Path = Path(settings.relay_path)
        self._local = local_http or httpx.AsyncClient(
            base_url=loopback_origin(settings), timeout=httpx.Timeout(None, connect=10.0)
        )
        self._relay = relay_http or httpx.AsyncClient(timeout=20.0)
        self._channel_factory = channel_factory
        # Flushed: under the desktop shell or a service manager stdout is a
        # pipe, and a buffered pairing code is one nobody sees in time.
        self._announce = announce or (lambda line: print(line, flush=True))

        saved = self._load()
        self._saved_config = {k: str(saved.get(k) or "") for k in ("url", "key", "web_url")}
        self._enabled = bool(saved.get("enabled"))
        self._link = self._parse_link(saved.get("link"))

        self.state = "off"
        self.error = ""
        self.channel: Any = None
        self._pairing: dict[str, Any] | None = None
        self._task: asyncio.Task | None = None
        self._inflight: dict[str, asyncio.Task] = {}
        self._partial: dict[str, dict[str, Any]] = {}
        self._callers: dict[str, tuple[str, float]] = {}

    # -- configuration -------------------------------------------------------

    @property
    def url(self) -> str:
        return (self._settings.relay_url or self._saved_config["url"]).rstrip("/")

    @property
    def key(self) -> str:
        return self._settings.relay_key or self._saved_config["key"]

    @property
    def web_url(self) -> str:
        return (self._settings.relay_web_url or self._saved_config["web_url"]).rstrip("/")

    @property
    def configured(self) -> bool:
        return bool(self.url and self.key)

    @property
    def linked(self) -> Link | None:
        return self._link

    def status(self) -> dict[str, Any]:
        link = self._link
        pairing = self._pairing
        return {
            "state": self.state,
            "error": self.error,
            "enabled": self._enabled,
            "configured": self.configured,
            "config": {
                "url": self.url,
                # Publishable by design -- it ships in the web client -- so it
                # is shown back rather than masked.
                "key": self.key,
                "web_url": self.web_url,
                "from_env": {
                    "url": bool(self._settings.relay_url),
                    "key": bool(self._settings.relay_key),
                    "web_url": bool(self._settings.relay_web_url),
                },
            },
            "device_name": device_name(self._settings),
            "linked": (
                {"host_id": link.host_id, "name": link.host_name, "owner_email": link.owner_email}
                if link
                else None
            ),
            "pairing": (
                {
                    "user_code": pairing["user_code"],
                    "expires_at": pairing["expires_at"],
                    "link_url": self._link_url(pairing["user_code"]),
                }
                if pairing
                else None
            ),
        }

    async def configure(self, url: str, key: str, web_url: str) -> None:
        url = (url or "").strip().rstrip("/")
        web_url = (web_url or "").strip().rstrip("/")
        if url and not re.match(r"^https://[^\s/]+$", url) and not re.match(r"^http://(127\.0\.0\.1|localhost)(:\d+)?$", url):
            raise ValueError("The relay address should look like https://<project>.supabase.co")
        if web_url and not re.match(r"^https?://[^\s]+$", web_url):
            raise ValueError("The web app address should start with https://")
        changed = url.rstrip("/") != self._saved_config["url"] or (key or "").strip() != self._saved_config["key"]
        self._saved_config = {"url": url, "key": (key or "").strip(), "web_url": web_url}
        if changed and self._link:
            # A link belongs to the project it was made in; in another one
            # the device's sign-in does not exist.
            self._link = None
            self._enabled = False
            await self._stop()
            self.state, self.error = "off", ""
        self._save()

    # -- switching it on and off --------------------------------------------

    async def start(self) -> None:
        """At boot: carry on where the last run left off."""
        if self._settings.remote_on_boot:
            if not self.configured:
                self._announce(
                    "[remote] --remote needs a relay: set BOM_RELAY_URL and BOM_RELAY_KEY "
                    "(see docs/remote.md)"
                )
                return
            self._enabled = True
            self._save()
        if self._enabled and self.configured:
            self._go()

    async def enable(self) -> None:
        if not self.configured:
            raise ValueError("Set the relay's address and key first.")
        self._enabled = True
        self.error = ""
        self._save()
        self._go()
        if self._link is None:
            # Answer with the code in hand, so the screen that asked can show
            # it at once rather than on its next look.
            for _ in range(100):
                if self._pairing or self.state != "pairing":
                    break
                await asyncio.sleep(0.05)

    async def disable(self) -> None:
        self._enabled = False
        self._save()
        await self._stop()
        self.state, self.error = "off", ""

    async def unlink(self) -> None:
        """Forget this device's link, and remove it from its owner's list."""
        link = self._link
        self._enabled = False
        await self._stop()
        if link and self.configured:
            try:
                session = await sign_in(self._relay, self.url, self.key, link.device_email, link.device_password)
                await call_function(
                    self._relay, self.url, self.key, "revoke", {"host_id": link.host_id}, jwt=session.access_token
                )
            except RelayError as exc:
                # Forgotten here either way. The owner can remove a leftover
                # entry from the web app; its sign-in no longer exists here.
                self._announce(f"[remote] couldn't remove this device from the relay: {exc}")
        self._link = None
        self._save()
        self.state, self.error = "off", ""

    async def aclose(self) -> None:
        await self._stop()
        await self._local.aclose()
        await self._relay.aclose()

    def _go(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
        # Said now, not when the task first runs: the caller reports status
        # straight after this.
        self.state = "connecting" if self._link else "pairing"
        self._task = asyncio.create_task(self._run() if self._link else self._pair(), name="remote-host")

    async def _stop(self) -> None:
        task, self._task = self._task, None
        if task and not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        await self._drop_channel()
        self._pairing = None

    async def _drop_channel(self) -> None:
        channel, self.channel = self.channel, None
        for task in list(self._inflight.values()):
            task.cancel()
        self._inflight.clear()
        self._partial.clear()
        if channel is not None:
            await channel.close()

    # -- pairing -------------------------------------------------------------

    async def _pair(self) -> None:
        unused = 0
        while True:
            self.state, self.error = "pairing", ""
            try:
                started = await call_function(
                    self._relay,
                    self.url,
                    self.key,
                    "start",
                    {"name": device_name(self._settings), "platform": platform_name()},
                )
            except RelayError as exc:
                self.state, self.error = "error", f"Couldn't start linking: {exc}"
                return
            self._pairing = {
                "user_code": started["user_code"],
                "device_code": started["device_code"],
                "expires_at": started["expires_at"],
            }
            self._announce_code()
            outcome = await self._await_approval(float(started.get("interval") or 3))
            if outcome == "approved":
                break
            self._pairing = None
            unused += 1
            if unused >= MAX_UNUSED_CODES:
                self._enabled = False
                self._save()
                self.state = "off"
                self.error = "No one used the code. Turn remote access on again for a new one."
                return
            self._announce("[remote] the code expired -- here is a new one")

        self._pairing = None
        link = self._link
        assert link is not None
        self._announce(f"[remote] linked to {link.owner_email or 'your account'} as \"{link.host_name}\"")
        await self._run()

    async def _await_approval(self, interval: float) -> str:
        pairing = self._pairing
        assert pairing is not None
        while True:
            await asyncio.sleep(interval)
            try:
                answer = await call_function(
                    self._relay, self.url, self.key, "poll", {"device_code": pairing["device_code"]}
                )
            except RelayError as exc:
                if exc.status in (404, 410):
                    return "expired"
                continue  # the network, probably; the code is still good
            if answer.get("status") == "approved":
                self._link = Link(
                    host_id=str(answer["host_id"]),
                    host_name=str(answer.get("host_name") or device_name(self._settings)),
                    owner_id=str(answer["owner_id"]),
                    owner_email=str(answer.get("owner_email") or ""),
                    device_email=str(answer["device_email"]),
                    device_password=str(answer["device_password"]),
                )
                self._save()
                return "approved"

    def _link_url(self, user_code: str) -> str | None:
        if not self.web_url:
            return None
        return f"{self.web_url}/?link={user_code.replace('-', '')}"

    def _announce_code(self) -> None:
        pairing = self._pairing
        if not pairing:
            return
        where = self._link_url(pairing["user_code"]) or "the Bom web app (Link a device)"
        self._announce(
            "\n"
            "  ┌ Remote access ─────────────────────────────────────\n"
            "  │ Link this machine to your account:\n"
            f"  │   open   {where}\n"
            f"  │   enter  {pairing['user_code']}\n"
            "  │ The code works once, for 10 minutes.\n"
            "  └────────────────────────────────────────────────────\n"
        )

    # -- staying connected ---------------------------------------------------

    async def _run(self) -> None:
        backoff = 1.0
        while True:
            link = self._link
            if link is None:
                return
            try:
                self.state = "connecting"
                try:
                    session = await sign_in(self._relay, self.url, self.key, link.device_email, link.device_password)
                except RelayError as exc:
                    if exc.status in (400, 401, 403, 422):
                        # The device's sign-in is gone: it was removed from
                        # the owner's account. Nothing to retry.
                        self._link = None
                        self._enabled = False
                        self._save()
                        self.state = "off"
                        self.error = "This device was removed from your account. Turn remote access on to link it again."
                        return
                    raise
                channel = self._channel_factory(
                    self.url, self.key, f"bom:host:{link.host_id}", on_broadcast=self.handle
                )
                await channel.open(session.access_token)
                self.channel = channel
                self.state, self.error = "online", ""
                backoff = 1.0
                await heartbeat(self._relay, self.url, self.key, session.access_token)
                upkeep = asyncio.create_task(self._upkeep(channel, session, link))
                try:
                    reason = await channel.wait_closed()
                finally:
                    upkeep.cancel()
                    await self._drop_channel()
                self.error = f"Reconnecting ({reason})"
            except asyncio.CancelledError:
                raise
            except ChannelRefused as exc:
                self.error = f"The relay refused this device's channel: {exc}"
            except (RelayError, ChannelClosed, OSError) as exc:
                self.error = f"Can't reach the relay: {exc}"
            except Exception as exc:  # noqa: BLE001 -- keep trying; say why
                self.error = f"Remote access failed: {exc}"
            self.state = "connecting"
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60.0)

    async def _upkeep(self, channel: Any, session: Session, link: Link) -> None:
        """Keep the token fresh and the "last seen" time current."""
        while True:
            await asyncio.sleep(60)
            if session.expires_at - time.time() < 300:
                try:
                    session = await sign_in(self._relay, self.url, self.key, link.device_email, link.device_password)
                    await channel.set_token(session.access_token)
                except (RelayError, ChannelClosed) as exc:
                    self._announce(f"[remote] refreshing the device's session: {exc}")
                    continue
            await heartbeat(self._relay, self.url, self.key, session.access_token)

    # -- requests ------------------------------------------------------------

    async def handle(self, event: str, payload: dict[str, Any]) -> None:
        """One broadcast from the channel."""
        rid = payload.get("id")
        if not isinstance(rid, str) or not _ID.match(rid):
            return
        if event == "ping":
            await self._send("pong", {"id": rid, "v": PROTOCOL})
        elif event == "req":
            await self._begin_request(rid, payload)
        elif event == "req-part":
            await self._add_part(rid, payload)
        elif event == "abort":
            task = self._inflight.get(rid)
            if task:
                task.cancel()
            self._partial.pop(rid, None)

    async def _begin_request(self, rid: str, payload: dict[str, Any]) -> None:
        if rid in self._inflight or rid in self._partial:
            return
        try:
            parts = int(payload.get("parts") or 1)
        except (TypeError, ValueError):
            parts = 0
        if not 1 <= parts <= MAX_PARTS:
            await self._refuse(rid, 413, "Request too large.")
            return
        entry = {
            "meta": payload,
            "parts": parts,
            "chunks": {0: str(payload.get("body") or "")},
            "started": time.monotonic(),
            "last": time.monotonic(),
        }
        if parts == 1:
            self._dispatch(rid, entry)
        else:
            self._partial[rid] = entry
            asyncio.get_running_loop().call_later(PARTIAL_TIMEOUT, self._expire_partial, rid)
            await self._send("req-ack", {"id": rid, "got": 1})

    def _expire_partial(self, rid: str) -> None:
        # Measured from the latest part, so a large upload arriving at a steady
        # pace is never cut off -- only one that has stopped.
        entry = self._partial.get(rid)
        if entry is None:
            return
        idle = time.monotonic() - entry["last"]
        if idle < PARTIAL_TIMEOUT:
            asyncio.get_running_loop().call_later(PARTIAL_TIMEOUT - idle, self._expire_partial, rid)
            return
        self._partial.pop(rid, None)
        asyncio.create_task(
            self._refuse(rid, 408, "Part of the upload was lost on the way through the relay. Try sending it again.")
        )

    async def _add_part(self, rid: str, payload: dict[str, Any]) -> None:
        entry = self._partial.get(rid)
        if entry is None:
            return
        try:
            index = int(payload.get("i"))
        except (TypeError, ValueError):
            return
        if not 0 < index < entry["parts"] or index in entry["chunks"]:
            return
        entry["chunks"][index] = str(payload.get("body") or "")
        entry["last"] = time.monotonic()
        got = len(entry["chunks"])
        if got == entry["parts"]:
            self._partial.pop(rid, None)
            self._dispatch(rid, entry)
        if got == entry["parts"] or got % ACK_EVERY == 0:
            await self._send("req-ack", {"id": rid, "got": got})

    def _dispatch(self, rid: str, entry: dict[str, Any]) -> None:
        if len(self._inflight) >= MAX_INFLIGHT:
            asyncio.create_task(self._refuse(rid, 503, "The host is busy. Try again in a moment."))
            return
        body = "".join(entry["chunks"][i] for i in range(entry["parts"]))
        task = asyncio.create_task(self._serve(rid, entry["meta"], body))
        self._inflight[rid] = task
        task.add_done_callback(lambda _t, rid=rid: self._inflight.pop(rid, None))

    async def _check(self, meta: dict[str, Any]) -> tuple[int, str] | None:
        """Why this request may not be served, or None if it may."""
        # Who it is from comes first: nothing else is said to a stranger.
        if not await self.verify_caller(meta.get("jwt")):
            return 401, "This account can't use this host."
        method = str(meta.get("method") or "GET").upper()
        if method not in ALLOWED_METHODS:
            return 405, "Method not allowed."
        path = clean_path(meta.get("path"))
        if path is None:
            return 400, "Bad path."
        if denied(path):
            return 403, "That can only be done at the host itself."
        return None

    async def verify_caller(self, jwt: Any) -> bool:
        """Whether a session token is a live one of this device's owner.

        Asked of the auth server, not decoded locally, so a forged or revoked
        token fails however it is signed. Remembered briefly, so a streaming
        conversation does not cost a round trip per request.
        """
        link = self._link
        if link is None or not isinstance(jwt, str) or not jwt or len(jwt) > 8192:
            return False
        digest = hashlib.sha256(jwt.encode()).hexdigest()
        now = time.time()
        hit = self._callers.get(digest)
        if hit and hit[1] > now:
            return hit[0] == link.owner_id
        try:
            user = await get_user(self._relay, self.url, self.key, jwt)
        except RelayError:
            return False
        user_id = str((user or {}).get("id") or "")
        until = now + (30.0 if not user_id else CALLER_TTL)
        expiry = token_expiry(jwt)
        if expiry is not None:
            until = min(until, expiry)
        if len(self._callers) > 256:
            self._callers = {k: v for k, v in self._callers.items() if v[1] > now}
        self._callers[digest] = (user_id, until)
        return bool(user_id) and user_id == link.owner_id

    async def _serve(self, rid: str, meta: dict[str, Any], body: str) -> None:
        sent = {"seq": 0}
        try:
            problem = await self._check(meta)
            if problem:
                await self._refuse(rid, *problem)
                return
            headers = {"Authorization": "Bearer " + self._settings.auth_token, RELAY_HEADER: "1"}
            content_type = meta.get("content_type")
            if isinstance(content_type, str) and 0 < len(content_type) < 200:
                headers["Content-Type"] = content_type
            # Until the local API starts its reply (it reads an attached PDF
            # first, say), say the request is still alive, as _pump does after.
            alive = asyncio.create_task(self._keep_alive(rid))
            try:
                async with self._local.stream(
                    str(meta.get("method") or "GET").upper(),
                    "/api" + str(meta["path"]),
                    content=body.encode("utf-8") if body else None,
                    headers=headers,
                ) as response:
                    alive.cancel()
                    await self._send(
                        "res-head",
                        {
                            "id": rid,
                            "status": response.status_code,
                            "headers": {k: response.headers[k] for k in PASSED_HEADERS if k in response.headers},
                        },
                    )
                    await self._pump(rid, response, sent)
            finally:
                alive.cancel()
            await self._send("res-end", {"id": rid, "count": sent["seq"]})
        except asyncio.CancelledError:
            # Aborted by the client, or the channel went away. Leaving the
            # stream closes the loopback connection, which the API treats as
            # a finished turn -- whatever was written is kept.
            raise
        except Exception as exc:  # noqa: BLE001 -- say what went wrong, to the one waiting
            try:
                await self._send("res-end", {"id": rid, "count": sent["seq"], "error": str(exc) or type(exc).__name__})
            except Exception:  # noqa: BLE001
                pass

    async def _keep_alive(self, rid: str) -> None:
        while True:
            await asyncio.sleep(KEEPALIVE_SECONDS)
            await self._send("res-alive", {"id": rid})

    async def _pump(self, rid: str, response: httpx.Response, sent: dict[str, int]) -> None:
        """Stream a reply back, a few frames a second rather than one per token."""
        decoder = (
            codecs.getincrementaldecoder("utf-8")("replace")
            if textual(response.headers.get("content-type", ""))
            else None
        )
        queue: asyncio.Queue[bytes | None] = asyncio.Queue()

        async def read() -> None:
            try:
                async for chunk in response.aiter_bytes():
                    await queue.put(chunk)
            finally:
                await queue.put(None)

        reader = asyncio.create_task(read())
        loop = asyncio.get_running_loop()
        buffer = bytearray()
        finished = False
        try:
            while not finished:
                try:
                    first = await asyncio.wait_for(queue.get(), KEEPALIVE_SECONDS)
                except (TimeoutError, asyncio.TimeoutError):
                    await self._send("res-alive", {"id": rid})
                    continue
                if first is None:
                    break
                buffer += first
                deadline = loop.time() + COALESCE_SECONDS
                while len(buffer) < MAX_PART:
                    remaining = deadline - loop.time()
                    if remaining <= 0:
                        break
                    try:
                        more = await asyncio.wait_for(queue.get(), remaining)
                    except (TimeoutError, asyncio.TimeoutError):
                        break
                    if more is None:
                        finished = True
                        break
                    buffer += more
                while buffer:
                    piece = bytes(buffer[:MAX_PART])
                    del buffer[:MAX_PART]
                    await self._emit(rid, piece, decoder, sent)
            if decoder is not None:
                tail = decoder.decode(b"", final=True)
                if tail:
                    await self._send("res-body", {"id": rid, "seq": sent["seq"], "text": tail})
                    sent["seq"] += 1
            # Surfaces a read error (the local server dropping mid-reply).
            await reader
        finally:
            reader.cancel()

    async def _emit(self, rid: str, piece: bytes, decoder: Any, sent: dict[str, int]) -> None:
        frame: dict[str, Any] = {"id": rid, "seq": sent["seq"]}
        if decoder is not None:
            text = decoder.decode(piece)
            if not text:
                return  # half a character; the rest comes with the next piece
            frame["text"] = text
        else:
            frame["b64"] = base64.b64encode(piece).decode("ascii")
        await self._send("res-body", frame)
        sent["seq"] += 1

    async def _refuse(self, rid: str, status: int, message: str) -> None:
        await self._send("res-head", {"id": rid, "status": status, "headers": {"content-type": "application/json"}})
        await self._send("res-body", {"id": rid, "seq": 0, "text": json.dumps({"detail": message})})
        await self._send("res-end", {"id": rid, "count": 1})

    async def _send(self, event: str, payload: dict[str, Any]) -> None:
        channel = self.channel
        if channel is None:
            raise ChannelClosed("not connected")
        await channel.send(event, payload)

    # -- persistence ---------------------------------------------------------

    def _load(self) -> dict[str, Any]:
        try:
            data = json.loads(self._file.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    @staticmethod
    def _parse_link(raw: Any) -> Link | None:
        if not isinstance(raw, dict):
            return None
        try:
            link = Link(**{k: str(raw[k]) for k in Link.__dataclass_fields__})
        except KeyError:
            return None
        return link if link.host_id and link.owner_id and link.device_email and link.device_password else None

    def _save(self) -> None:
        data = {**self._saved_config, "enabled": self._enabled, "link": asdict(self._link) if self._link else None}
        self._file.parent.mkdir(parents=True, exist_ok=True)
        temp = self._file.with_suffix(".tmp")
        # Created 0600 rather than chmodded after: the device's password is in
        # it, and there should be no moment when it is readable by others.
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2)
        os.replace(temp, self._file)
