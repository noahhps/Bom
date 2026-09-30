"""The few Supabase REST calls the host makes: the pairing function, the
device's sign-in, checking who a caller is, and a heartbeat.

Plain httpx rather than supabase-py, for the reason realtime.py gives.
"""

from __future__ import annotations

import base64
import json
import time
from dataclasses import dataclass
from typing import Any

import httpx


class RelayError(Exception):
    """The relay answered and said no, or could not be reached (status 0)."""

    def __init__(self, message: str, status: int = 0) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Session:
    access_token: str
    expires_at: float
    user_id: str


def _headers(key: str, jwt: str | None = None) -> dict[str, str]:
    headers = {"apikey": key, "Content-Type": "application/json"}
    if jwt:
        headers["Authorization"] = "Bearer " + jwt
    return headers


def _reason(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return response.text[:300] or response.reason_phrase
    if isinstance(body, dict):
        for field in ("error", "msg", "message", "error_description"):
            if isinstance(body.get(field), str):
                return body[field]
    return json.dumps(body)[:300]


async def call_function(
    http: httpx.AsyncClient, url: str, key: str, route: str, body: dict[str, Any], *, jwt: str | None = None
) -> dict[str, Any]:
    try:
        response = await http.post(
            f"{url.rstrip('/')}/functions/v1/bom-pair/{route}", headers=_headers(key, jwt), json=body
        )
    except httpx.HTTPError as exc:
        raise RelayError(f"couldn't reach the relay: {exc}") from exc
    if response.status_code == 404 and "Requested function was not found" in response.text:
        # The function itself is missing -- not a code it did not recognise.
        raise RelayError("the relay has no bom-pair function -- run relay/setup.sh", 404)
    if response.status_code >= 400:
        raise RelayError(_reason(response), response.status_code)
    return response.json()


async def sign_in(http: httpx.AsyncClient, url: str, key: str, email: str, password: str) -> Session:
    """The device's own sign-in, by the password the pairing gave it."""
    try:
        response = await http.post(
            f"{url.rstrip('/')}/auth/v1/token?grant_type=password",
            headers=_headers(key),
            json={"email": email, "password": password},
        )
    except httpx.HTTPError as exc:
        raise RelayError(f"couldn't reach the relay: {exc}") from exc
    if response.status_code >= 400:
        raise RelayError(_reason(response), response.status_code)
    data = response.json()
    expires_in = float(data.get("expires_in") or 3600)
    return Session(
        access_token=data["access_token"],
        expires_at=time.time() + expires_in,
        user_id=str((data.get("user") or {}).get("id") or ""),
    )


async def get_user(http: httpx.AsyncClient, url: str, key: str, jwt: str) -> dict[str, Any] | None:
    """Who a token belongs to, asked of the auth server itself. None if it is
    not a live token. Raises RelayError when the answer is unknowable."""
    try:
        response = await http.get(f"{url.rstrip('/')}/auth/v1/user", headers=_headers(key, jwt))
    except httpx.HTTPError as exc:
        raise RelayError(f"couldn't reach the relay: {exc}") from exc
    if response.status_code in (401, 403):
        return None
    if response.status_code >= 400:
        raise RelayError(_reason(response), response.status_code)
    return response.json()


async def heartbeat(http: httpx.AsyncClient, url: str, key: str, jwt: str) -> None:
    try:
        await http.post(f"{url.rstrip('/')}/rest/v1/rpc/bom_host_heartbeat", headers=_headers(key, jwt), json={})
    except httpx.HTTPError:
        pass  # only the "last seen" time; the channel itself is what matters


def token_expiry(jwt: str) -> float | None:
    """The `exp` a JWT claims, read without verifying it -- only ever used to
    decide how long to *remember* a verification the auth server made."""
    try:
        payload = jwt.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        exp = json.loads(base64.urlsafe_b64decode(payload)).get("exp")
        return float(exp) if exp else None
    except (IndexError, ValueError, TypeError):
        return None
