"""Signing in to hosted MCP servers: Atlassian, Linear, Notion, Sentry and the rest.

The hosted servers a company uses do not take a pasted key. They follow the MCP
authorization spec, which is OAuth 2.1 with the pieces a client that has never
met the server needs to find its own way in:

    1. discover   The server answers an unsigned request with 401 and a
                  `WWW-Authenticate` header naming its protected-resource
                  metadata (RFC 9728). That names the authorization server,
                  whose own metadata (RFC 8414) names its endpoints.
    2. register   With no client id handed out in advance, Bom registers
                  itself (RFC 7591, dynamic client registration) as a public
                  client with this server's callback as its redirect.
    3. sign in    PKCE authorization-code flow in the reader's browser, with
                  the MCP server named as the `resource` (RFC 8707) so the
                  token is minted for it and nothing else.
    4. use        The access token rides as a bearer header; when it expires
                  the refresh token gets a new one, without asking again.

Until this, the only way to reach these servers was `mcp-remote`, a bridge that
runs its own sign-in in a browser on whichever machine runs Bom -- which is not
the device in the reader's hand when Bom is served to a phone or a laptop on the
network. Here the sign-in happens in the reader's own browser, like the
OpenRouter sign-in, and comes back to this server's callback.

No client secret is ever baked in: every copy of Bom registers itself. The
state in the callback URL is the only thing between that unauthenticated route
and a code being spent here, so it is 256 random bits, single-use, and expires
with the flow.
"""

from __future__ import annotations

import base64
import hashlib
import secrets
import time
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import urlencode, urlparse, urlunparse

import httpx

from .protocol import MCPAuthRequired, MCPError

#: Where the browser comes back to, on this server. Fixed rather than per
#: flow, because the authorization server checks it against the redirect the
#: client registered, character for character.
CALLBACK_PATH = "/mcp/oauth/callback"

#: Long enough to find the password manager and click through a consent page.
FLOW_TTL_SECONDS = 900.0
MAX_FLOWS = 8

#: Refreshed this long before it expires, so a token is never sent in its last
#: seconds and refused on arrival.
EXPIRY_MARGIN_SECONDS = 60

_TIMEOUT = httpx.Timeout(connect=10.0, read=20.0, write=10.0, pool=5.0)


class MCPOAuthError(MCPError):
    """Signing in could not go ahead. The message is written to be shown."""


@dataclass
class Flow:
    """One sign-in, from the button to the tokens."""

    state: str
    verifier: str
    server_id: str
    server_name: str
    redirect_uri: str
    url: str
    created_at: float
    status: str = "pending"  # pending | connected | failed
    error: str = ""

    def expired(self, now: float) -> bool:
        return now - self.created_at > FLOW_TTL_SECONDS

    def to_dict(self) -> dict[str, Any]:
        # Never the verifier: this is what a polling browser sees.
        return {
            "state": self.state,
            "status": self.status,
            "error": self.error,
            "server_id": self.server_id,
            "server": self.server_name,
        }


def _challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def canonical_resource(url: str) -> str:
    """The MCP server's URL as the `resource` it is named by: lower-case scheme
    and host, no fragment, no trailing slash (RFC 8707 and the MCP spec)."""
    parsed = urlparse((url or "").strip())
    path = parsed.path.rstrip("/")
    return urlunparse((parsed.scheme.lower(), parsed.netloc.lower(), path, "", parsed.query, ""))


def callback_url(base: str) -> str:
    """The redirect for a sign-in started from `base` -- the origin the reader's
    browser reached this server on, which is the only address that browser can
    be sent back to."""
    cleaned = (base or "").strip().rstrip("/")
    parsed = urlparse(cleaned)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise MCPOAuthError(f"{base!r} is not an address a browser can return to")
    return f"{parsed.scheme}://{parsed.netloc}{CALLBACK_PATH}"


def _well_known(issuer: str, name: str) -> list[str]:
    """Where `name` metadata may live for `issuer`, most specific first.

    RFC 8414 inserts the well-known segment between the host and any path
    (`/.well-known/oauth-authorization-server/tenant`); OpenID Connect
    appends it. Servers in the wild do both, so both are tried.
    """
    parsed = urlparse(issuer)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    path = parsed.path.rstrip("/")
    if not path:
        return [f"{origin}/.well-known/{name}"]
    return [f"{origin}/.well-known/{name}{path}", f"{origin}{path}/.well-known/{name}"]


class MCPOAuth:
    """Sign-ins to MCP servers, and the tokens they leave behind. One per app."""

    def __init__(
        self,
        store,
        *,
        client_factory: Callable[[], httpx.AsyncClient] | None = None,
        client_name: str = "Bom",
    ) -> None:
        self.store = store
        # Swappable so tests can stand a whole authorization server up in
        # memory; everything here goes through it.
        self._client_factory = client_factory or (
            lambda: httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True)
        )
        self.client_name = client_name
        self.flows: dict[str, Flow] = {}

    # -- what is known --------------------------------------------------------

    def signed_in(self, server_id: str) -> bool:
        return bool(self.store.get_mcp_auth(server_id)["tokens"].get("access_token"))

    def sign_out(self, server_id: str) -> None:
        """Forget the tokens. The registration is kept: it names this app, not
        the person, and registering again on every sign-in would leave a trail
        of dead clients on the other side."""
        self.store.put_mcp_auth(server_id, tokens=None)

    def get(self, state: str) -> Flow | None:
        self._sweep()
        return self.flows.get(state)

    # -- 1. discover ------------------------------------------------------------

    async def discover(self, url: str, challenge: MCPAuthRequired | None = None) -> dict[str, Any]:
        """Find the authorization server for the MCP server at `url`.

        Returns the endpoints, the `resource` to name, and the scope to ask for
        when the server says. Asks the server itself for a challenge first when
        none was passed in, because the header on its 401 is the most direct
        pointer there is.
        """
        async with self._client_factory() as http:
            if challenge is None:
                challenge = await self._probe(http, url)

            resource_meta: dict[str, Any] = {}
            candidates = []
            if challenge is not None and challenge.resource_metadata:
                candidates.append(challenge.resource_metadata)
            candidates += _well_known(canonical_resource(url), "oauth-protected-resource")
            parsed = urlparse(url)
            candidates.append(f"{parsed.scheme}://{parsed.netloc}/.well-known/oauth-protected-resource")
            for candidate in dict.fromkeys(candidates):
                resource_meta = await self._json(http, candidate)
                if resource_meta:
                    break

            servers = resource_meta.get("authorization_servers") or []
            # A server from before protected-resource metadata (the 2025-03-26
            # spec) is its own authorization server, at its origin.
            issuer = str(servers[0]) if servers else f"{parsed.scheme}://{parsed.netloc}"

            auth_meta: dict[str, Any] = {}
            for candidate in _well_known(issuer, "oauth-authorization-server") + _well_known(
                issuer, "openid-configuration"
            ):
                auth_meta = await self._json(http, candidate)
                if auth_meta.get("authorization_endpoint") and auth_meta.get("token_endpoint"):
                    break
            else:
                auth_meta = {}

        base = issuer.rstrip("/")
        scope = (challenge.scope if challenge else "") or " ".join(
            str(s) for s in (resource_meta.get("scopes_supported") or [])
        )
        return {
            "issuer": issuer,
            # The 2025-03-26 defaults, for a server that publishes no metadata.
            "authorization_endpoint": auth_meta.get("authorization_endpoint") or f"{base}/authorize",
            "token_endpoint": auth_meta.get("token_endpoint") or f"{base}/token",
            "registration_endpoint": auth_meta.get("registration_endpoint")
            or ("" if auth_meta else f"{base}/register"),
            "resource": str(resource_meta.get("resource") or canonical_resource(url)),
            "scope": scope,
            "pkce": auth_meta.get("code_challenge_methods_supported") or ["S256"],
        }

    async def _probe(self, http: httpx.AsyncClient, url: str) -> MCPAuthRequired | None:
        """An unsigned initialize, for the challenge on the 401 it gets."""
        try:
            response = await http.post(
                url,
                json={"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {
                    "protocolVersion": "2025-06-18", "capabilities": {},
                    "clientInfo": {"name": self.client_name, "version": "0.1.0"}}},
                headers={"Accept": "application/json, text/event-stream"},
            )
        except httpx.HTTPError:
            return None
        if response.status_code == 401:
            return MCPAuthRequired(url, response.headers.get("www-authenticate", ""))
        return None

    @staticmethod
    async def _json(http: httpx.AsyncClient, url: str) -> dict[str, Any]:
        try:
            response = await http.get(url, headers={"Accept": "application/json"})
        except httpx.HTTPError:
            return {}
        if response.status_code >= 400:
            return {}
        try:
            body = response.json()
        except ValueError:
            return {}
        return body if isinstance(body, dict) else {}

    # -- 2. register ------------------------------------------------------------

    async def _client_for(self, server_id: str, meta: dict[str, Any], redirect_uri: str) -> dict:
        """This app's client at the server's authorization server, registered
        now if it never was -- or was, for a different redirect."""
        stored = self.store.get_mcp_auth(server_id)
        client = stored["client"]
        if (
            client.get("client_id")
            and client.get("redirect_uri") == redirect_uri
            and client.get("issuer") == meta["issuer"]
        ):
            return client
        endpoint = meta.get("registration_endpoint")
        if not endpoint:
            raise MCPOAuthError(
                "This server does not let apps register themselves, so Bom cannot "
                "sign in to it directly. Use an access token if it offers one, or "
                "the remote_bridge preset."
            )
        body: dict[str, Any] = {
            "client_name": self.client_name,
            "redirect_uris": [redirect_uri],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        }
        if meta.get("scope"):
            body["scope"] = meta["scope"]
        async with self._client_factory() as http:
            try:
                response = await http.post(endpoint, json=body)
            except httpx.HTTPError as exc:
                raise MCPOAuthError(f"could not reach the sign-in server: {exc}") from exc
        if response.status_code >= 400:
            raise MCPOAuthError(
                f"the server refused to register Bom ({response.status_code}): "
                f"{_error_text(response)}"
            )
        registered = response.json() if response.content else {}
        if not registered.get("client_id"):
            raise MCPOAuthError("the server registered Bom but sent back no client id")
        client = {
            "client_id": registered["client_id"],
            "client_secret": registered.get("client_secret", ""),
            "auth_method": registered.get("token_endpoint_auth_method")
            or ("client_secret_basic" if registered.get("client_secret") else "none"),
            "redirect_uri": redirect_uri,
            "issuer": meta["issuer"],
        }
        self.store.put_mcp_auth(server_id, client=client)
        return client

    # -- 3. sign in -------------------------------------------------------------

    async def begin(self, server, callback_base: str, challenge: MCPAuthRequired | None = None) -> Flow:
        """Start signing in to `server`; the caller sends the browser to
        `flow.url`, and the server's answer comes back to the callback."""
        if not getattr(server, "url", None):
            raise MCPOAuthError(f"'{server.name}' is not a hosted server; there is nothing to sign in to")
        redirect_uri = callback_url(callback_base)
        meta = await self.discover(server.url, challenge)
        if "S256" not in meta["pkce"]:
            raise MCPOAuthError("the server does not support PKCE (S256), which signing in requires")
        client = await self._client_for(server.id, meta, redirect_uri)
        self.store.put_mcp_auth(server.id, metadata=meta)

        state = secrets.token_urlsafe(32)
        verifier = secrets.token_urlsafe(72)
        params = {
            "response_type": "code",
            "client_id": client["client_id"],
            "redirect_uri": redirect_uri,
            "state": state,
            "code_challenge": _challenge(verifier),
            "code_challenge_method": "S256",
            "resource": meta["resource"],
        }
        if meta.get("scope"):
            params["scope"] = meta["scope"]
        endpoint = meta["authorization_endpoint"]
        joiner = "&" if urlparse(endpoint).query else "?"
        flow = Flow(
            state=state,
            verifier=verifier,
            server_id=server.id,
            server_name=server.name,
            redirect_uri=redirect_uri,
            url=f"{endpoint}{joiner}{urlencode(params)}",
            created_at=time.monotonic(),
        )
        self.flows[state] = flow
        self._sweep()
        return flow

    async def complete(self, state: str, code: str) -> Flow:
        """Trade the code the browser brought back for tokens, and keep them.

        Single use: the verifier is spent before the request goes out, so a
        reloaded callback tab fails cleanly instead of trying the code twice.
        """
        self._sweep()
        flow = self.flows.get(state)
        if flow is None:
            raise MCPOAuthError("that sign-in has expired -- start it again")
        if not flow.verifier:
            raise MCPOAuthError("that sign-in has already been used")
        if not (code or "").strip():
            flow.status, flow.error = "failed", "the server sent no code back"
            raise MCPOAuthError(flow.error)
        verifier, flow.verifier = flow.verifier, ""

        stored = self.store.get_mcp_auth(flow.server_id)
        meta, client = stored["metadata"], stored["client"]
        try:
            tokens = await self._token_request(meta, client, {
                "grant_type": "authorization_code",
                "code": code.strip(),
                "redirect_uri": flow.redirect_uri,
                "code_verifier": verifier,
            })
        except MCPOAuthError as exc:
            flow.status, flow.error = "failed", str(exc)
            raise
        self.store.put_mcp_auth(flow.server_id, tokens=tokens)
        flow.status = "connected"
        return flow

    def fail(self, state: str, error: str) -> None:
        """The browser came back with an error instead of a code."""
        flow = self.flows.get(state)
        if flow is not None and flow.status == "pending":
            flow.verifier = ""
            flow.status, flow.error = "failed", error

    # -- 4. use -------------------------------------------------------------------

    async def bearer(self, server) -> str | None:
        """A current access token for `server`, refreshed first if it is about
        to expire; None when there is none to send."""
        tokens = self.store.get_mcp_auth(server.id)["tokens"]
        if not tokens.get("access_token"):
            return None
        expires_at = tokens.get("expires_at")
        if expires_at is not None and time.time() > float(expires_at) - EXPIRY_MARGIN_SECONDS:
            if not await self.refresh(server):
                return None
            tokens = self.store.get_mcp_auth(server.id)["tokens"]
        return tokens.get("access_token") or None

    async def refresh(self, server) -> bool:
        """Get a new access token with the refresh token. False, and the tokens
        forgotten, when the server will not give one -- the reader has to sign
        in again, and a token known to be dead should not keep being sent."""
        stored = self.store.get_mcp_auth(server.id)
        tokens, meta, client = stored["tokens"], stored["metadata"], stored["client"]
        refresh_token = tokens.get("refresh_token")
        if not refresh_token or not meta.get("token_endpoint") or not client.get("client_id"):
            self.store.put_mcp_auth(server.id, tokens=None)
            return False
        try:
            fresh = await self._token_request(meta, client, {
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
            })
        except MCPOAuthError:
            self.store.put_mcp_auth(server.id, tokens=None)
            return False
        # A server that does not rotate refresh tokens sends none back; the
        # old one still stands.
        fresh.setdefault("refresh_token", refresh_token)
        self.store.put_mcp_auth(server.id, tokens=fresh)
        return True

    async def _token_request(self, meta: dict, client: dict, form: dict[str, str]) -> dict:
        form = {**form, "client_id": client.get("client_id", "")}
        if meta.get("resource"):
            form["resource"] = meta["resource"]
        auth = None
        secret = client.get("client_secret")
        if secret and client.get("auth_method") == "client_secret_post":
            form["client_secret"] = secret
        elif secret:
            auth = (client["client_id"], secret)
        async with self._client_factory() as http:
            try:
                response = await http.post(
                    meta["token_endpoint"],
                    data=form,
                    auth=auth,
                    headers={"Accept": "application/json"},
                )
            except httpx.HTTPError as exc:
                raise MCPOAuthError(f"could not reach the sign-in server: {exc}") from exc
        if response.status_code >= 400:
            raise MCPOAuthError(f"the server refused the sign-in: {_error_text(response)}")
        try:
            body = response.json()
        except ValueError as exc:
            raise MCPOAuthError("the server's answer was not JSON") from exc
        if not body.get("access_token"):
            raise MCPOAuthError("the server sent back no access token")
        tokens = {
            "access_token": body["access_token"],
            "token_type": body.get("token_type", "Bearer"),
            "scope": body.get("scope", ""),
        }
        if body.get("refresh_token"):
            tokens["refresh_token"] = body["refresh_token"]
        if body.get("expires_in"):
            tokens["expires_at"] = int(time.time() + float(body["expires_in"]))
        return tokens

    def _sweep(self) -> None:
        now = time.monotonic()
        for state, flow in list(self.flows.items()):
            if flow.expired(now):
                del self.flows[state]
        while len(self.flows) > MAX_FLOWS:
            oldest = min(self.flows.values(), key=lambda f: f.created_at)
            del self.flows[oldest.state]


def _error_text(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return (response.text or "").strip()[:200] or str(response.status_code)
    if isinstance(body, dict):
        for key in ("error_description", "error", "message"):
            if body.get(key):
                return str(body[key])[:300]
    return str(response.status_code)
