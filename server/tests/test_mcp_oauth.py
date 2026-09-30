"""Signing in to hosted MCP servers, against an authorization server and an MCP
server stood up in memory: discovery from the 401, dynamic registration, the
PKCE exchange with the resource named, bearer tokens on the connection, and
refresh when they lapse."""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.db import Database
from app.main import create_app
from app.mcp.manager import MCPManager
from app.mcp.oauth import CALLBACK_PATH, MCPOAuth, MCPOAuthError, callback_url
from app.mcp.presets import get_preset, resolve_preset
from app.mcp.protocol import MCPAuthRequired
from app.mcp.transports import HttpSseTransport
from app.skills.registry import Registry
from app.store import Store

MCP_URL = "https://mcp.test/mcp"
ISSUER = "https://auth.test/tenant"


class World:
    """An MCP server behind an OAuth authorization server, in one handler."""

    def __init__(self, *, registration: bool = True, prm: bool = True) -> None:
        self.registration = registration
        self.prm = prm
        self.registered: list[dict] = []
        self.token_requests: list[dict] = []
        self.challenges: dict[str, str] = {}   # client_id -> last code challenge
        self.valid = {"good-token", "fresh-token"}
        self.refresh_ok = True
        self.seen_auth: list[str] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url).split("?")[0]
        if url == MCP_URL and request.method == "POST":
            auth = request.headers.get("authorization", "")
            self.seen_auth.append(auth)
            if auth.removeprefix("Bearer ") not in self.valid:
                challenge = 'Bearer scope="issues:read"'
                if self.prm:
                    challenge += (
                        ', resource_metadata="https://mcp.test/.well-known/'
                        'oauth-protected-resource/mcp"'
                    )
                return httpx.Response(401, headers={"WWW-Authenticate": challenge})
            body = json.loads(request.content)
            if "id" not in body:
                return httpx.Response(202)
            method = body["method"]
            if method == "initialize":
                result = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}},
                          "serverInfo": {"name": "tracker"}}
            elif method == "tools/list":
                result = {"tools": [{"name": "search_issues", "description": "Find issues",
                                     "inputSchema": {"type": "object", "properties": {}}}]}
            elif method == "tools/call":
                result = {"content": [{"type": "text", "text": "ISSUE-1: broken login"}]}
            else:
                return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"],
                                                 "error": {"code": -32601, "message": "nope"}})
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": result},
                                  headers={"mcp-session-id": "s1"})
        if url == MCP_URL and request.method == "DELETE":
            return httpx.Response(200)
        if url == "https://mcp.test/.well-known/oauth-protected-resource/mcp" and self.prm:
            return httpx.Response(200, json={
                "resource": MCP_URL,
                "authorization_servers": [ISSUER],
                "scopes_supported": ["issues:read", "issues:write"],
            })
        if url == "https://auth.test/.well-known/oauth-authorization-server/tenant":
            meta = {
                "issuer": ISSUER,
                "authorization_endpoint": f"{ISSUER}/authorize",
                "token_endpoint": f"{ISSUER}/token",
                "code_challenge_methods_supported": ["S256"],
            }
            if self.registration:
                meta["registration_endpoint"] = f"{ISSUER}/register"
            return httpx.Response(200, json=meta)
        if url == "https://mcp.test/.well-known/oauth-authorization-server" and not self.prm:
            return httpx.Response(200, json={
                "issuer": "https://mcp.test",
                "authorization_endpoint": "https://mcp.test/authorize",
                "token_endpoint": "https://mcp.test/token",
                "registration_endpoint": "https://mcp.test/register",
                "code_challenge_methods_supported": ["S256"],
            })
        if url.endswith("/register") and request.method == "POST":
            body = json.loads(request.content)
            self.registered.append(body)
            return httpx.Response(201, json={"client_id": f"bom-{len(self.registered)}",
                                             **body})
        if url.endswith("/token") and request.method == "POST":
            form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
            self.token_requests.append(form)
            if form.get("grant_type") == "authorization_code":
                digest = hashlib.sha256(form["code_verifier"].encode()).digest()
                challenge = base64.urlsafe_b64encode(digest).decode().rstrip("=")
                if form.get("code") != "the-code" or challenge != self.challenges.get(form["client_id"]):
                    return httpx.Response(400, json={"error": "invalid_grant"})
                return httpx.Response(200, json={"access_token": "good-token", "token_type": "Bearer",
                                                 "refresh_token": "r1", "expires_in": 3600})
            if form.get("grant_type") == "refresh_token":
                if not self.refresh_ok or form.get("refresh_token") != "r1":
                    return httpx.Response(400, json={"error": "invalid_grant",
                                                     "error_description": "refresh token revoked"})
                return httpx.Response(200, json={"access_token": "fresh-token", "expires_in": 3600})
        return httpx.Response(404)

    def factory(self):
        return lambda: httpx.AsyncClient(transport=httpx.MockTransport(self.handler))

    def authorize(self, url: str) -> dict:
        """What the consent page does: remember the challenge, hand back a code."""
        query = {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}
        self.challenges[query["client_id"]] = query["code_challenge"]
        return query


@pytest.fixture
def store(tmp_path: Path) -> Store:
    return Store(Database(tmp_path / "o.db"))


@pytest.fixture
def world(monkeypatch) -> World:
    w = World()
    monkeypatch.setattr(HttpSseTransport, "client_factory", staticmethod(w.factory()))
    return w


def _server(store: Store, url: str = MCP_URL, headers: dict | None = None):
    return store.add_mcp_server(name="tracker", transport="http", url=url, headers=headers or {})


# -- discovery and sign-in -------------------------------------------------------


@pytest.mark.asyncio
async def test_discovery_follows_the_401_to_the_authorization_server(store, world):
    meta = await MCPOAuth(store, client_factory=world.factory()).discover(MCP_URL)
    assert meta["issuer"] == ISSUER
    assert meta["authorization_endpoint"] == f"{ISSUER}/authorize"
    assert meta["token_endpoint"] == f"{ISSUER}/token"
    assert meta["registration_endpoint"] == f"{ISSUER}/register"
    assert meta["resource"] == MCP_URL
    # The scope the challenge asked for wins over everything supported.
    assert meta["scope"] == "issues:read"


@pytest.mark.asyncio
async def test_a_server_without_resource_metadata_is_its_own_issuer(store, monkeypatch):
    world = World(prm=False)
    meta = await MCPOAuth(store, client_factory=world.factory()).discover(MCP_URL)
    assert meta["issuer"] == "https://mcp.test"
    assert meta["token_endpoint"] == "https://mcp.test/token"


@pytest.mark.asyncio
async def test_signing_in_registers_asks_with_pkce_and_keeps_the_tokens(store, world):
    oauth = MCPOAuth(store, client_factory=world.factory())
    server = _server(store)

    flow = await oauth.begin(server, "http://127.0.0.1:8080/")
    assert flow.redirect_uri == "http://127.0.0.1:8080" + CALLBACK_PATH
    registered = world.registered[0]
    assert registered["redirect_uris"] == [flow.redirect_uri]
    assert registered["token_endpoint_auth_method"] == "none"

    query = world.authorize(flow.url)
    assert flow.url.startswith(f"{ISSUER}/authorize?")
    assert query["response_type"] == "code"
    assert query["code_challenge_method"] == "S256"
    assert query["resource"] == MCP_URL
    assert query["state"] == flow.state
    assert query["redirect_uri"] == flow.redirect_uri
    assert "code_verifier" not in flow.url

    assert not oauth.signed_in(server.id)
    done = await oauth.complete(flow.state, "the-code")
    assert done.status == "connected"
    assert oauth.signed_in(server.id)
    exchange = world.token_requests[-1]
    assert exchange["resource"] == MCP_URL and exchange["client_id"] == "bom-1"
    assert await oauth.bearer(server) == "good-token"

    # Single use: the same callback twice does not spend the code again.
    with pytest.raises(MCPOAuthError):
        await oauth.complete(flow.state, "the-code")
    # And a second sign-in reuses the registration.
    await oauth.begin(server, "http://127.0.0.1:8080")
    assert len(world.registered) == 1


@pytest.mark.asyncio
async def test_a_different_callback_address_registers_again(store, world):
    oauth = MCPOAuth(store, client_factory=world.factory())
    server = _server(store)
    await oauth.begin(server, "http://127.0.0.1:8080")
    await oauth.begin(server, "http://192.168.1.20:8080")
    assert len(world.registered) == 2


@pytest.mark.asyncio
async def test_a_server_that_will_not_register_apps_says_so(store):
    world = World(registration=False)
    oauth = MCPOAuth(store, client_factory=world.factory())
    with pytest.raises(MCPOAuthError, match="register themselves"):
        await oauth.begin(_server(store), "http://127.0.0.1:8080")


@pytest.mark.asyncio
async def test_unknown_and_refused_sign_ins(store, world):
    oauth = MCPOAuth(store, client_factory=world.factory())
    with pytest.raises(MCPOAuthError, match="expired"):
        await oauth.complete("nope", "the-code")
    flow = await oauth.begin(_server(store), "http://127.0.0.1:8080")
    oauth.fail(flow.state, "access_denied")
    assert oauth.get(flow.state).status == "failed"
    with pytest.raises(MCPOAuthError):
        await oauth.complete(flow.state, "the-code")


def test_the_callback_needs_an_address_a_browser_can_reach():
    assert callback_url("http://localhost:8080/") == "http://localhost:8080/mcp/oauth/callback"
    with pytest.raises(MCPOAuthError):
        callback_url("tauri://localhost")


# -- the connection ---------------------------------------------------------------


async def _signed_in(store, world) -> tuple[MCPOAuth, object]:
    oauth = MCPOAuth(store, client_factory=world.factory())
    server = _server(store)
    flow = await oauth.begin(server, "http://127.0.0.1:8080")
    world.authorize(flow.url)
    await oauth.complete(flow.state, "the-code")
    return oauth, server


@pytest.mark.asyncio
async def test_an_unsigned_server_asks_for_a_sign_in_then_connects_with_the_token(store, world):
    oauth = MCPOAuth(store, client_factory=world.factory())
    manager = MCPManager(store, Registry(), oauth=oauth)
    server = _server(store)

    with pytest.raises(MCPAuthRequired):
        await manager.sync_server(server)
    assert manager.needs_sign_in("tracker")
    assert "Sign in to tracker" in manager.last_error("tracker")
    assert manager.challenge("tracker").resource_metadata.endswith("/oauth-protected-resource/mcp")

    flow = await oauth.begin(server, "http://127.0.0.1:8080", manager.challenge("tracker"))
    world.authorize(flow.url)
    await oauth.complete(flow.state, "the-code")

    tools = await manager.sync_server(server)
    assert tools == ["search_issues"]
    assert not manager.needs_sign_in("tracker")
    assert world.seen_auth[-1] == "Bearer good-token"
    assert "ISSUE-1" in await manager.call_tool("tracker", "search_issues", {})


@pytest.mark.asyncio
async def test_an_expired_token_is_refreshed_quietly(store, world):
    oauth, server = await _signed_in(store, world)
    tokens = store.get_mcp_auth(server.id)["tokens"]
    store.put_mcp_auth(server.id, tokens={**tokens, "expires_at": 0})

    manager = MCPManager(store, Registry(), oauth=oauth)
    assert await manager.sync_server(server) == ["search_issues"]
    assert world.seen_auth[-1] == "Bearer fresh-token"
    # The refresh token was not rotated, so the old one is kept.
    assert store.get_mcp_auth(server.id)["tokens"]["refresh_token"] == "r1"


@pytest.mark.asyncio
async def test_a_revoked_token_is_refreshed_on_the_401(store, world):
    oauth, server = await _signed_in(store, world)
    manager = MCPManager(store, Registry(), oauth=oauth)
    await manager.sync_server(server)
    # The server stops honouring the access token mid-conversation.
    world.valid = {"fresh-token"}
    assert "ISSUE-1" in await manager.call_tool("tracker", "search_issues", {})
    assert world.seen_auth[-1] == "Bearer fresh-token"


@pytest.mark.asyncio
async def test_a_refusal_to_refresh_asks_for_a_sign_in(store, world):
    oauth, server = await _signed_in(store, world)
    manager = MCPManager(store, Registry(), oauth=oauth)
    world.valid = set()
    world.refresh_ok = False
    with pytest.raises(MCPAuthRequired):
        await manager.sync_server(server)
    assert manager.needs_sign_in("tracker")
    assert not oauth.signed_in(server.id)   # a dead token is not kept around


@pytest.mark.asyncio
async def test_a_configured_token_wins_over_a_signed_in_one(store, world):
    oauth, _ = await _signed_in(store, world)
    world.valid.add("my-api-key")
    server = store.add_mcp_server(
        name="keyed", transport="http", url=MCP_URL,
        headers={"Authorization": "Bearer my-api-key"},
    )
    manager = MCPManager(store, Registry(), oauth=oauth)
    await manager.sync_server(server)
    assert world.seen_auth[-1] == "Bearer my-api-key"


# -- presets ----------------------------------------------------------------------


def test_work_presets_sign_in_unless_given_a_key():
    for name in ("atlassian", "linear", "notion", "sentry", "stripe", "hosted_oauth"):
        preset = get_preset(name)
        assert preset["category"] == "work" and preset["auth"] == "oauth"
        assert preset["transport"] == "http"
    # Linear with no key sends no Authorization header -- it signs in instead.
    assert "Authorization" not in (resolve_preset(get_preset("linear"), {}).get("headers") or {})
    keyed = resolve_preset(get_preset("linear"), {"LINEAR_API_KEY": "lin_api_x"})
    assert keyed["headers"]["Authorization"] == "Bearer lin_api_x"
    # The token preset carries only the product that was filled in.
    jira = resolve_preset(get_preset("jira_confluence"), {
        "JIRA_URL": "https://acme.atlassian.net", "JIRA_USERNAME": "a@acme.com",
        "JIRA_API_TOKEN": "t",
    })
    assert set(jira["env"]) == {"JIRA_URL", "JIRA_USERNAME", "JIRA_API_TOKEN"}


# -- over HTTP ----------------------------------------------------------------------


def test_the_api_and_callback_sign_a_server_in(tmp_path: Path, world):
    app = create_app(Settings(db_path=tmp_path / "api.db", auth_token="t"))
    app.state.mcp_oauth._client_factory = world.factory()
    client = TestClient(app, headers={"Authorization": "Bearer t"})

    added = client.post("/api/mcp/presets/instantiate",
                        json={"preset": "hosted_oauth", "name": "tracker",
                              "values": {"REMOTE_URL": MCP_URL}}).json()
    assert added["connected"] is False
    assert added["auth"] == {"signed_in": False, "required": True, "can_sign_in": True}
    assert added["error"] == "Sign in to tracker to use its tools."

    started = client.post(f"/api/mcp/servers/{added['id']}/signin",
                          json={"callback_base": "http://testserver"}).json()
    assert started["callback"] == "http://testserver" + CALLBACK_PATH
    query = world.authorize(started["url"])
    assert client.get(f"/api/mcp/signin/{started['state']}").json()["status"] == "pending"

    # The browser comes back -- to a route that needs no token.
    page = TestClient(app).get(CALLBACK_PATH, params={"state": query["state"], "code": "the-code"})
    assert page.status_code == 200 and "tracker connected" in page.text

    report = client.get(f"/api/mcp/signin/{started['state']}").json()
    assert report["status"] == "connected"
    assert report["server_status"]["connected"] is True
    assert report["server_status"]["tools"] == ["search_issues"]
    assert report["server_status"]["auth"]["signed_in"] is True
    # The tokens never leave the server.
    assert "good-token" not in json.dumps(report)
    assert "good-token" not in json.dumps(client.get("/api/mcp/servers").json())

    out = client.delete(f"/api/mcp/servers/{added['id']}/signin").json()
    assert out["auth"]["signed_in"] is False and out["connected"] is False
    # Offered straight back, without a sync first.
    assert out["auth"]["required"] is True
    assert out["error"].startswith("Signed out.")


def test_a_cancelled_sign_in_is_reported(tmp_path: Path, world):
    app = create_app(Settings(db_path=tmp_path / "api.db", auth_token="t"))
    app.state.mcp_oauth._client_factory = world.factory()
    client = TestClient(app, headers={"Authorization": "Bearer t"})
    server = client.post("/api/mcp/servers", json={"name": "tracker", "transport": "http",
                                                   "url": MCP_URL}).json()
    started = client.post(f"/api/mcp/servers/{server['id']}/signin",
                          json={"callback_base": "http://testserver"}).json()
    page = TestClient(app).get(CALLBACK_PATH, params={"state": started["state"],
                                                      "error": "access_denied"})
    assert page.status_code == 400
    report = client.get(f"/api/mcp/signin/{started['state']}").json()
    assert report["status"] == "failed" and report["error"] == "access_denied"
