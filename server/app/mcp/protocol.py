"""JSON-RPC 2.0 and MCP protocol message definitions."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any


class MCPError(Exception):
    """Base exception for Model Context Protocol errors."""


class MCPTransportError(MCPError):
    """Raised when communication with an MCP server fails or disconnects."""


class MCPAuthRequired(MCPTransportError):
    """The server answered 401: it wants a signed-in user, not a request.

    Carries what the server said in `WWW-Authenticate`, because under the MCP
    authorization spec that header is where it names its protected-resource
    metadata (and sometimes the scope it wants) -- the first step of signing
    in. See oauth.py.
    """

    def __init__(self, url: str, www_authenticate: str = "", detail: str = "") -> None:
        detail = (detail or "").strip()[:200]
        super().__init__(
            f"HTTP 401 from '{url}': sign-in required" + (f" ({detail})" if detail else "")
        )
        self.url = url
        self.www_authenticate = www_authenticate or ""
        params = parse_www_authenticate(self.www_authenticate)
        self.resource_metadata = params.get("resource_metadata", "")
        self.scope = params.get("scope", "")
        self.error = params.get("error", "")


def parse_www_authenticate(header: str) -> dict[str, str]:
    """The parameters of a Bearer challenge: `Bearer realm="x", scope="a b"`.

    Quoted values may hold commas and spaces, so this reads key="value" pairs
    rather than splitting on commas.
    """
    found: dict[str, str] = {}
    for key, quoted, bare in re.findall(r'([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))', header or ""):
        found[key.lower()] = (quoted if quoted else bare).replace('\\"', '"')
    return found


class MCPProtocolError(MCPError):
    """Raised when an MCP server returns a JSON-RPC error response."""

    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(f"MCP Error [{code}]: {message}")
        self.code = code
        self.message = message
        self.data = data


class MCPTimeoutError(MCPError):
    """Raised when an MCP request times out."""


@dataclass
class MCPToolInfo:
    """Metadata describing a single tool discovered from an MCP server."""

    name: str
    description: str = ""
    input_schema: dict[str, Any] = field(
        default_factory=lambda: {"type": "object", "properties": {}}
    )


def format_jsonrpc_request(
    request_id: int | str, method: str, params: dict[str, Any] | None = None
) -> str:
    """Encode a JSON-RPC 2.0 request as a single-line JSON string."""
    payload: dict[str, Any] = {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": method,
    }
    if params is not None:
        payload["params"] = params
    return json.dumps(payload, ensure_ascii=False)


def format_jsonrpc_notification(
    method: str, params: dict[str, Any] | None = None
) -> str:
    """Encode a JSON-RPC 2.0 notification (no id) as a single-line JSON string."""
    payload: dict[str, Any] = {
        "jsonrpc": "2.0",
        "method": method,
    }
    if params is not None:
        payload["params"] = params
    return json.dumps(payload, ensure_ascii=False)


def parse_jsonrpc_response(line: str) -> dict[str, Any]:
    """Parse a single line of JSON-RPC response."""
    line = line.strip()
    if not line:
        raise MCPProtocolError(-32700, "Empty JSON-RPC message received")
    try:
        data = json.loads(line)
    except json.JSONDecodeError as exc:
        raise MCPProtocolError(-32700, f"Parse error: {exc}") from exc

    if not isinstance(data, dict):
        raise MCPProtocolError(-32600, "Invalid Request: expected JSON object")
    return data
