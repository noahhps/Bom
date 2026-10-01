"""Remote access: the bridge that serves relayed requests, and who it lets in.

The relay itself (Supabase) is not here. The channel is a fake that records
what the bridge broadcasts, the auth server is an httpx mock, and the API the
bridge forwards to is a small stand-in -- so what is tested is exactly the
bridge: who it serves, what it refuses, and that a reply survives the trip
intact, streaming and binary included.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import stat
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.responses import Response, StreamingResponse
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.remote.host import (
    MAX_PART,
    RELAY_HEADER,
    Link,
    RemoteHost,
    clean_path,
    denied,
    loopback_origin,
)
from app.remote import host as host_module
from app.remote.realtime import RealtimeChannel, realtime_url
from app.remote.supabase import token_expiry

OWNER = "11111111-1111-4111-8111-111111111111"
STRANGER = "22222222-2222-4222-8222-222222222222"
TOKENS = {"owner-jwt": OWNER, "stranger-jwt": STRANGER}


# -- the stand-in API ---------------------------------------------------------


def stand_in() -> FastAPI:
    app = FastAPI()

    @app.middleware("http")
    async def check(request: Request, call_next):
        # Every forwarded request carries the local token and the relay mark.
        if request.headers.get("authorization") != "Bearer local-token":
            return Response(status_code=401)
        if request.headers.get(RELAY_HEADER) != "1":
            return Response(status_code=400)
        return await call_next(request)

    @app.get("/api/hello")
    async def hello():
        return {"hello": "world"}

    @app.post("/api/echo")
    async def echo(request: Request):
        body = await request.body()
        return {"length": len(body), "type": request.headers.get("content-type"), "body": body.decode()}

    @app.get("/api/stream")
    async def stream():
        async def frames():
            # A multibyte character split across two chunks: the decoder on
            # the host has to hold the first half back rather than mangle it.
            snow = "☃".encode()
            yield b"event: delta\ndata: {\"text\": \"a" + snow[:1]
            await asyncio.sleep(0.06)
            yield snow[1:] + b"\"}\n\n"
            yield b"event: done\ndata: {}\n\n"

        return StreamingResponse(frames(), media_type="text/event-stream")

    @app.get("/api/blob")
    async def blob():
        return Response(bytes(range(256)) * 1000, media_type="image/png")

    @app.delete("/api/thing")
    async def delete():
        return Response(status_code=204)

    return app


class FakeChannel:
    def __init__(self) -> None:
        self.sent: list[tuple[str, dict[str, Any]]] = []

    async def send(self, event: str, payload: dict[str, Any]) -> None:
        self.sent.append((event, payload))

    async def close(self) -> None:
        pass

    def reply(self, rid: str) -> dict[str, Any]:
        """Reassemble what the bridge sent for one request, as a client would."""
        head = next(p for e, p in self.sent if e == "res-head" and p["id"] == rid)
        end = next(p for e, p in self.sent if e == "res-end" and p["id"] == rid)
        parts = sorted((p for e, p in self.sent if e == "res-body" and p["id"] == rid), key=lambda p: p["seq"])
        assert [p["seq"] for p in parts] == list(range(end["count"]))
        body = b"".join(
            p["text"].encode() if "text" in p else base64.b64decode(p["b64"]) for p in parts
        )
        return {"status": head["status"], "headers": head["headers"], "body": body, "end": end}


def auth_server(calls: list[str]) -> httpx.MockTransport:
    def handle(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/auth/v1/user"
        assert request.headers["apikey"] == "anon-key"
        token = request.headers.get("authorization", "")[7:]
        calls.append(token)
        if token in TOKENS:
            return httpx.Response(200, json={"id": TOKENS[token], "email": "x@example.com"})
        return httpx.Response(401, json={"msg": "invalid JWT"})

    return httpx.MockTransport(handle)


def make_host(tmp_path: Path, calls: list[str] | None = None) -> tuple[RemoteHost, FakeChannel]:
    settings = Settings(
        db_path=tmp_path / "x.db",
        auth_token="local-token",
        relay_url="https://example.supabase.co",
        relay_key="anon-key",
        relay_path=tmp_path / "relay.json",
    )
    host = RemoteHost(
        settings,
        local_http=httpx.AsyncClient(transport=httpx.ASGITransport(app=stand_in()), base_url="http://host"),
        relay_http=httpx.AsyncClient(transport=auth_server(calls if calls is not None else [])),
        announce=lambda _line: None,
    )
    host._link = Link(
        host_id="33333333-3333-4333-8333-333333333333",
        host_name="Test box",
        owner_id=OWNER,
        owner_email="owner@example.com",
        device_email="d@devices.bom.invalid",
        device_password="pw",
    )
    channel = FakeChannel()
    host.channel = channel
    return host, channel


async def serve(host: RemoteHost, rid: str, **request: Any) -> None:
    await host.handle("req", {"id": rid, "jwt": "owner-jwt", "method": "GET", **request})
    await asyncio.gather(*list(host._inflight.values()))


# -- paths --------------------------------------------------------------------


@pytest.mark.parametrize(
    "path",
    ["/status", "/sessions/abc", "/workspace/file?root=%2Fhome%2Fme&path=a.txt", "/chat"],
)
def test_ordinary_paths_pass(path):
    assert clean_path(path) == path


@pytest.mark.parametrize(
    "path",
    [
        None,
        "status",
        "//evil.example/api",
        "/../healthz",
        "/sessions/../../x",
        "/sessions/%2e%2e/x",
        "/a%2fb",
        "/a\\b",
        "/a b",
        "/a\r\nX-Injected: 1",
        "/a#frag",
    ],
)
def test_hostile_paths_are_refused(path):
    assert clean_path(path) is None


def test_management_routes_are_denied_through_the_relay():
    assert denied("/remote/enable")
    assert denied("/remote")
    assert denied("/remote/status?x=1")
    assert denied("/terminal")
    assert not denied("/remotely-named-thing")
    assert not denied("/sessions")


def test_loopback_origin_follows_the_bind_address():
    assert loopback_origin(Settings(bind_host="0.0.0.0", bind_port=8080)) == "http://127.0.0.1:8080"
    assert loopback_origin(Settings(bind_host="127.0.0.1", bind_port=9)) == "http://127.0.0.1:9"
    assert loopback_origin(Settings(bind_host="::", bind_port=9)) == "http://[::1]:9"
    assert loopback_origin(Settings(bind_host="192.168.1.5", bind_port=9)) == "http://192.168.1.5:9"


def test_realtime_url_and_token_expiry():
    assert realtime_url("https://abc.supabase.co/", "k") == (
        "wss://abc.supabase.co/realtime/v1/websocket?apikey=k&vsn=1.0.0"
    )
    claims = base64.urlsafe_b64encode(json.dumps({"exp": 1700000000}).encode()).decode().rstrip("=")
    assert token_expiry(f"h.{claims}.s") == 1700000000
    assert token_expiry("not-a-jwt") is None


# -- serving ------------------------------------------------------------------


def test_the_owner_is_served(tmp_path):
    async def run():
        host, channel = make_host(tmp_path)
        await serve(host, "r1", path="/hello")
        reply = channel.reply("r1")
        assert reply["status"] == 200
        assert json.loads(reply["body"]) == {"hello": "world"}
        assert reply["headers"]["content-type"] == "application/json"
        assert "error" not in reply["end"]

    asyncio.run(run())


def test_anyone_else_is_refused_before_anything_else(tmp_path):
    async def run():
        host, channel = make_host(tmp_path)
        # A valid session -- of another account -- and no session at all.
        for rid, jwt in (("s1", "stranger-jwt"), ("s2", "forged"), ("s3", None)):
            await host.handle("req", {"id": rid, "jwt": jwt, "method": "GET", "path": "/remote/enable"})
            await asyncio.gather(*list(host._inflight.values()))
            reply = channel.reply(rid)
            # 401, not 403: a stranger learns nothing about which paths exist.
            assert reply["status"] == 401

    asyncio.run(run())


def test_the_owner_cannot_manage_remote_access_through_the_relay(tmp_path):
    async def run():
        host, channel = make_host(tmp_path)
        await serve(host, "m1", method="POST", path="/remote/disable")
        assert channel.reply("m1")["status"] == 403
        await serve(host, "m2", method="GET", path="/../healthz")
        assert channel.reply("m2")["status"] == 400
        await serve(host, "m3", method="TRACE", path="/hello")
        assert channel.reply("m3")["status"] == 405

    asyncio.run(run())


def test_an_unlinked_host_serves_no_one(tmp_path):
    async def run():
        host, channel = make_host(tmp_path)
        host._link = None
        await serve(host, "u1", path="/hello")
        assert channel.reply("u1")["status"] == 401

    asyncio.run(run())


def test_a_verified_session_is_remembered(tmp_path):
    async def run():
        calls: list[str] = []
        host, channel = make_host(tmp_path, calls)
        for n in range(3):
            await serve(host, f"c{n}", path="/hello")
        assert calls == ["owner-jwt"]

    asyncio.run(run())


def test_a_body_in_parts_is_put_back_together(tmp_path):
    async def run():
        host, channel = make_host(tmp_path)
        body = json.dumps({"text": "x" * (MAX_PART * 2 + 17)})
        parts = [body[i : i + MAX_PART] for i in range(0, len(body), MAX_PART)]
        assert len(parts) == 3
        await host.handle(
            "req",
            {
                "id": "p1",
                "jwt": "owner-jwt",
                "method": "POST",
                "path": "/echo",
                "content_type": "application/json",
                "parts": len(parts),
                "body": parts[0],
            },
        )
        # Out of order, and nothing is served until the last one lands.
        await host.handle("req-part", {"id": "p1", "i": 2, "body": parts[2]})
        assert not host._inflight
        await host.handle("req-part", {"id": "p1", "i": 1, "body": parts[1]})
        await asyncio.gather(*list(host._inflight.values()))
        echoed = json.loads(channel.reply("p1")["body"])
        assert echoed["length"] == len(body.encode())
        assert echoed["body"] == body
        assert echoed["type"] == "application/json"

    asyncio.run(run())


def test_an_upload_that_stops_arriving_is_reported(tmp_path, monkeypatch):
    monkeypatch.setattr(host_module, "PARTIAL_TIMEOUT", 0.2)

    async def run():
        host, channel = make_host(tmp_path)
        start = {"jwt": "owner-jwt", "method": "POST", "path": "/echo", "parts": 3, "body": "{"}
        # Parts arriving steadily keep the upload alive past the timeout...
        await host.handle("req", {"id": "slow", **start})
        for i in (1, 2):
            await asyncio.sleep(0.15)
            await host.handle("req-part", {"id": "slow", "i": i, "body": "}" if i == 2 else ""})
        await asyncio.gather(*list(host._inflight.values()))
        assert channel.reply("slow")["status"] == 200
        # ...and one whose last part never comes is answered, not dropped.
        await host.handle("req", {"id": "lost", **start})
        await host.handle("req-part", {"id": "lost", "i": 1, "body": ""})
        await asyncio.sleep(0.35)
        assert "lost" not in host._partial
        reply = channel.reply("lost")
        assert reply["status"] == 408
        assert "lost on the way" in json.loads(reply["body"])["detail"]

    asyncio.run(run())


def test_a_stream_arrives_whole_and_in_order(tmp_path):
    async def run():
        host, channel = make_host(tmp_path)
        await serve(host, "st", path="/stream")
        reply = channel.reply("st")
        assert reply["headers"]["content-type"].startswith("text/event-stream")
        text = reply["body"].decode("utf-8")
        assert '"a☃"' in text
        assert text.endswith("event: done\ndata: {}\n\n")
        # Coalesced: the sleep splits it in two, not into one frame per chunk.
        frames = [p for e, p in channel.sent if e == "res-body" and p["id"] == "st"]
        assert 1 <= len(frames) <= 3
        assert all("text" in f for f in frames)

    asyncio.run(run())


def test_binary_replies_go_as_base64_in_parts(tmp_path):
    async def run():
        host, channel = make_host(tmp_path)
        await serve(host, "b1", path="/blob")
        reply = channel.reply("b1")
        assert reply["body"] == bytes(range(256)) * 1000
        frames = [p for e, p in channel.sent if e == "res-body" and p["id"] == "b1"]
        assert len(frames) >= 3  # 256 KB in parts of at most MAX_PART
        assert all(len(base64.b64decode(f["b64"])) <= MAX_PART for f in frames)

    asyncio.run(run())


def test_an_empty_reply_ends_cleanly(tmp_path):
    async def run():
        host, channel = make_host(tmp_path)
        await serve(host, "d1", method="DELETE", path="/thing")
        reply = channel.reply("d1")
        assert reply["status"] == 204
        assert reply["body"] == b""
        assert reply["end"]["count"] == 0

    asyncio.run(run())


def test_ping_is_answered_and_junk_ids_are_ignored(tmp_path):
    async def run():
        host, channel = make_host(tmp_path)
        await host.handle("ping", {"id": "p"})
        await host.handle("req", {"id": "../../x", "jwt": "owner-jwt", "path": "/hello"})
        await host.handle("req", {"id": "x" * 65, "jwt": "owner-jwt", "path": "/hello"})
        assert channel.sent == [("pong", {"id": "p"})]

    asyncio.run(run())


def test_abort_cancels_the_request(tmp_path):
    async def run():
        host, channel = make_host(tmp_path)
        started = asyncio.Event()

        async def forever(*_a, **_k):
            started.set()
            await asyncio.sleep(3600)

        host._serve = forever  # type: ignore[method-assign]
        await host.handle("req", {"id": "a1", "jwt": "owner-jwt", "path": "/hello"})
        task = host._inflight["a1"]
        await started.wait()
        await host.handle("abort", {"id": "a1"})
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0)
        assert "a1" not in host._inflight

    asyncio.run(run())


# -- pairing and the link -----------------------------------------------------


def test_pairing_links_the_device_and_keeps_its_secret_private(tmp_path):
    async def run():
        polls = {"n": 0}

        def relay(request: httpx.Request) -> httpx.Response:
            route = request.url.path.rsplit("/", 1)[-1]
            if route == "start":
                body = json.loads(request.content)
                assert body["name"] == "Test box"
                return httpx.Response(
                    200,
                    json={
                        "user_code": "ABCD-EFGH",
                        "device_code": "d" * 43,
                        "expires_at": "2099-01-01T00:00:00Z",
                        "interval": 0.05,
                    },
                )
            if route == "poll":
                polls["n"] += 1
                if polls["n"] < 2:
                    return httpx.Response(200, json={"status": "pending"})
                return httpx.Response(
                    200,
                    json={
                        "status": "approved",
                        "host_id": "44444444-4444-4444-8444-444444444444",
                        "host_name": "Test box",
                        "owner_id": OWNER,
                        "owner_email": "owner@example.com",
                        "device_email": "dev@devices.bom.invalid",
                        "device_password": "secret-pw",
                    },
                )
            raise AssertionError(request.url)

        settings = Settings(
            db_path=tmp_path / "x.db",
            auth_token="t",
            relay_url="https://example.supabase.co",
            relay_key="anon-key",
            relay_path=tmp_path / "relay.json",
            remote_name="Test box",
        )
        lines: list[str] = []
        host = RemoteHost(
            settings, relay_http=httpx.AsyncClient(transport=httpx.MockTransport(relay)), announce=lines.append
        )
        connected = asyncio.Event()

        async def run_stub() -> None:
            connected.set()

        host._run = run_stub  # type: ignore[method-assign]
        await host.enable()
        # enable() answers with the code already in hand.
        status = host.status()
        assert status["state"] == "pairing"
        assert status["pairing"]["user_code"] == "ABCD-EFGH"
        assert "device_code" not in json.dumps(status)  # the poll secret never leaves
        assert any("ABCD-EFGH" in line for line in lines)
        await asyncio.wait_for(connected.wait(), 2)

        assert host.linked is not None and host.linked.owner_id == OWNER
        saved = json.loads((tmp_path / "relay.json").read_text())
        assert saved["enabled"] is True
        assert saved["link"]["device_password"] == "secret-pw"
        assert "secret-pw" not in json.dumps(host.status())
        if os.name == "posix":
            assert stat.S_IMODE((tmp_path / "relay.json").stat().st_mode) == 0o600
        await host.aclose()

    asyncio.run(run())


def test_a_removed_device_forgets_its_link(tmp_path):
    async def run():
        def relay(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/auth/v1/token"
            return httpx.Response(400, json={"error_description": "Invalid login credentials"})

        host, _ = make_host(tmp_path)
        host._relay = httpx.AsyncClient(transport=httpx.MockTransport(relay))
        host._enabled = True
        await host._run()
        assert host.linked is None
        assert host.state == "off"
        assert "removed" in host.error
        assert json.loads((tmp_path / "relay.json").read_text())["enabled"] is False

    asyncio.run(run())


def test_changing_project_drops_the_link(tmp_path):
    async def run():
        settings = Settings(db_path=tmp_path / "x.db", auth_token="t", relay_path=tmp_path / "relay.json")
        host = RemoteHost(settings, announce=lambda _l: None)
        await host.configure("https://one.supabase.co", "k1", "")
        host._link = Link("h", "n", OWNER, "", "e", "p")
        await host.configure("https://one.supabase.co", "k1", "https://bom.example.com")
        assert host.linked is not None  # only the web address changed
        await host.configure("https://two.supabase.co", "k1", "")
        assert host.linked is None
        with pytest.raises(ValueError):
            await host.configure("ftp://nope", "k", "")
        await host.aclose()

    asyncio.run(run())


# -- the routes ---------------------------------------------------------------


def app_client(tmp_path: Path, client_host: str) -> TestClient:
    settings = Settings(db_path=tmp_path / "api.db", auth_token="t", relay_path=tmp_path / "relay.json")
    return TestClient(create_app(settings), headers={"Authorization": "Bearer t"}, client=(client_host, 5000))


def test_only_this_machine_may_change_remote_access(tmp_path):
    away = app_client(tmp_path, "192.168.1.20")
    status = away.get("/api/remote/status").json()
    assert status["can_manage"] is False
    assert status["state"] == "off"
    for method, path in (("post", "/api/remote/enable"), ("post", "/api/remote/unlink"), ("put", "/api/remote/config")):
        response = getattr(away, method)(path, **({"json": {}} if method == "put" else {}))
        assert response.status_code == 403, path


def test_a_relayed_request_is_not_this_machine(tmp_path):
    here = app_client(tmp_path, "127.0.0.1")
    assert here.get("/api/remote/status").json()["can_manage"] is True
    relayed = here.get("/api/remote/status", headers={RELAY_HEADER: "1"}).json()
    assert relayed["can_manage"] is False
    assert relayed["via_relay"] is True
    assert here.post("/api/remote/enable", headers={RELAY_HEADER: "1"}).status_code == 403


def test_configuring_at_this_machine(tmp_path):
    here = app_client(tmp_path, "127.0.0.1")
    assert here.post("/api/remote/enable").status_code == 400  # nothing to connect to yet
    response = here.put(
        "/api/remote/config",
        json={"url": "https://abc.supabase.co/", "key": "anon", "web_url": "https://bom.example.com"},
    )
    assert response.status_code == 200
    config = response.json()["config"]
    assert config["url"] == "https://abc.supabase.co"
    assert config["web_url"] == "https://bom.example.com"
    assert response.json()["configured"] is True
    assert here.put("/api/remote/config", json={"url": "not a url"}).status_code == 400


def test_the_routes_need_the_token(tmp_path):
    here = app_client(tmp_path, "127.0.0.1")
    assert here.get("/api/remote/status", headers={"Authorization": ""}).status_code == 401


def test_the_channel_joins_privately_with_the_token():
    async def run():
        written: list[dict[str, Any]] = []

        class Socket:
            def __init__(self) -> None:
                self.inbox: asyncio.Queue = asyncio.Queue()

            async def send(self, raw: str) -> None:
                message = json.loads(raw)
                written.append(message)
                if message["event"] == "phx_join":
                    await self.inbox.put(
                        json.dumps(
                            {
                                "topic": message["topic"],
                                "event": "phx_reply",
                                "ref": message["ref"],
                                "payload": {"status": "ok", "response": {}},
                            }
                        )
                    )

            def __aiter__(self):
                return self

            async def __anext__(self):
                return await self.inbox.get()

            async def close(self) -> None:
                pass

        socket = Socket()
        got: list[tuple[str, dict]] = []

        async def on(event: str, payload: dict) -> None:
            got.append((event, payload))

        async def connect(url: str, **_kw: Any) -> Socket:
            assert url.startswith("wss://abc.supabase.co/realtime/v1/websocket?apikey=k")
            return socket

        channel = RealtimeChannel("https://abc.supabase.co", "k", "bom:host:x", on_broadcast=on, connect=connect)
        await channel.open("device-jwt")
        join = written[0]
        assert join["topic"] == "realtime:bom:host:x"
        assert join["payload"]["config"]["private"] is True
        assert join["payload"]["access_token"] == "device-jwt"

        await socket.inbox.put(
            json.dumps(
                {
                    "topic": "realtime:bom:host:x",
                    "event": "broadcast",
                    "payload": {"type": "broadcast", "event": "req", "payload": {"id": "1"}},
                }
            )
        )
        await channel.send("res-head", {"id": "1", "status": 200})
        await asyncio.sleep(0.05)
        assert got == [("req", {"id": "1"})]
        sent = written[-1]
        assert sent["event"] == "broadcast"
        assert sent["payload"] == {"type": "broadcast", "event": "res-head", "payload": {"id": "1", "status": 200}}

        await socket.inbox.put(json.dumps({"topic": "realtime:bom:host:x", "event": "phx_close", "payload": {}}))
        assert "close" in await asyncio.wait_for(channel.wait_closed(), 1)
        await channel.close()

    asyncio.run(run())
