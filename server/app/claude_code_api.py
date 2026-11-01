"""The routes for the Claude Code backend (providers/claude_code.py).

Two kinds. The plan's status is behind the bearer token like the rest of the
API. The MCP bridge is not, and cannot be: its caller is the `claude` process a
turn started, which has no Bom token -- and must not be handed one. What stands
in for it is the per-turn secret that is the URL's last segment (256 bits,
minted when the turn starts, gone when it ends), plus the rule that only this
machine may call: the process is always local.
"""

from __future__ import annotations

import ipaddress

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response

from .providers.claude_code import ClaudeCodeProvider


def _is_local(host: str, allowed: str) -> bool:
    if host == allowed:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return host == "localhost"


def build_claude_code_router(provider: ClaudeCodeProvider, auth, bind_host: str) -> APIRouter:
    router = APIRouter()

    @router.get("/providers/claude-code/status", dependencies=[Depends(auth)])
    async def plan_status() -> dict:
        """Installed, signed in, and how -- asked afresh, for the settings page."""
        return await provider.auth_status(fresh=True)

    @router.post("/claude-code/mcp/{token}")
    async def mcp(token: str, request: Request) -> Response:
        host = request.client.host if request.client else ""
        if not _is_local(host, bind_host):
            raise HTTPException(404)
        try:
            payload = await request.json()
        except ValueError:
            return JSONResponse(
                {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}},
                status_code=400,
            )
        try:
            answer = await provider.bridge.handle(token, payload)
        except KeyError:
            raise HTTPException(404) from None
        if answer is None:
            return Response(status_code=202)
        return JSONResponse(answer)

    # No server-initiated stream to open, and nothing to tear down: a turn's
    # session is the turn.
    @router.get("/claude-code/mcp/{token}")
    async def mcp_stream(token: str) -> Response:
        return Response(status_code=405, headers={"Allow": "POST"})

    @router.delete("/claude-code/mcp/{token}")
    async def mcp_end(token: str) -> Response:
        return Response(status_code=200)

    return router
