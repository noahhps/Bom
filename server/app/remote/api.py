"""/api/remote: turning remote access on and off, at the host.

Behind the bearer token like everything else, and then behind one more rule:
anything that *changes* remote access must come from this machine. A phone on
the LAN holding the token can see the status but cannot switch hosting on, and
a request that came in through the relay cannot reach these routes at all --
the bridge refuses them before they are forwarded, and this refuses them again
by the header the bridge sets.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from .host import RELAY_HEADER, RemoteHost

_LOOPBACK = frozenset(("127.0.0.1", "::1", "localhost"))


class RelayConfigIn(BaseModel):
    url: str = Field(default="", max_length=300)
    key: str = Field(default="", max_length=2000)
    web_url: str = Field(default="", max_length=300)


def at_this_machine(request: Request, settings: Any) -> bool:
    """Whether a request was made at the host rather than from elsewhere."""
    if request.headers.get(RELAY_HEADER):
        return False
    client = request.client.host if request.client else ""
    if client in _LOOPBACK or client.startswith("127."):
        return True
    # Bound to one LAN address: a browser on this machine reaches it from
    # that same address, and any other machine from a different one.
    bound = str(settings.bind_host or "")
    return bool(bound) and bound not in ("0.0.0.0", "::") and client == bound


def build_remote_router(remote: RemoteHost, auth, settings: Any) -> APIRouter:
    router = APIRouter(prefix="/remote", dependencies=[Depends(auth)])

    def require_here(request: Request) -> None:
        if not at_this_machine(request, settings):
            raise HTTPException(
                status_code=403,
                detail="Remote access can only be changed at the host itself. Open Bom on that machine.",
            )

    def status(request: Request) -> dict[str, Any]:
        return {
            **remote.status(),
            "can_manage": at_this_machine(request, settings),
            "via_relay": bool(request.headers.get(RELAY_HEADER)),
        }

    @router.get("/status")
    async def get_status(request: Request) -> dict[str, Any]:
        return status(request)

    @router.put("/config", dependencies=[Depends(require_here)])
    async def put_config(body: RelayConfigIn, request: Request) -> dict[str, Any]:
        try:
            await remote.configure(body.url, body.key, body.web_url)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return status(request)

    @router.post("/enable", dependencies=[Depends(require_here)])
    async def enable(request: Request) -> dict[str, Any]:
        try:
            await remote.enable()
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return status(request)

    @router.post("/disable", dependencies=[Depends(require_here)])
    async def disable(request: Request) -> dict[str, Any]:
        await remote.disable()
        return status(request)

    @router.post("/unlink", dependencies=[Depends(require_here)])
    async def unlink(request: Request) -> dict[str, Any]:
        await remote.unlink()
        return status(request)

    return router
