"""The Claude Code backend, against a stand-in `claude` that speaks its protocol.

The stand-in is a small script on CLAUDE_CODE_BIN: it answers `--version` and
`auth status`, and in print mode prints stream-json events. When it is given an
MCP server it does what Claude Code does with one -- announces a skill call,
then makes it over HTTP against Bom's bridge and waits for the answer -- so the
whole round trip is exercised: Claude asks, the round ends, Bom answers, the
same process carries on. No real Claude Code and no Claude plan is involved.
"""

from __future__ import annotations

import asyncio
import json
import socket
import sys
import textwrap

import pytest
import uvicorn
from fastapi import FastAPI

from app.claude_code_api import build_claude_code_router
from app.providers.base import Message, ProviderError
from app.providers.claude_code import ClaudeCodeProvider, _user_message

FAKE_CLAUDE = textwrap.dedent(
    r'''
    import json, os, sys, urllib.request

    args = sys.argv[1:]
    if args == ["--version"]:
        print("9.9.9 (Claude Code)"); sys.exit(0)
    if args[:2] == ["auth", "status"]:
        logged = os.environ.get("FAKE_LOGGED_IN", "1") == "1"
        print(json.dumps({"loggedIn": logged, "authMethod": "claude.ai" if logged else "none"}))
        sys.exit(0 if logged else 1)

    # What a turn was started with, for the test to read back.
    with open(os.environ["FAKE_ARGS_OUT"], "w") as f:
        json.dump({"args": args, "env_has_key": "ANTHROPIC_API_KEY" in os.environ,
                   "cwd": os.getcwd()}, f)

    user = json.loads(sys.stdin.readline())
    def out(event): print(json.dumps(event), flush=True)
    def say(text): out({"type": "stream_event", "event": {"type": "content_block_delta",
                        "delta": {"type": "text_delta", "text": text}}})

    out({"type": "system", "subtype": "init", "model": "sonnet"})
    if os.environ.get("FAKE_MODE") == "noauth":
        out({"type": "result", "subtype": "success", "is_error": True,
             "result": "Not logged in · Please run /login"})
        sys.exit(1)

    if "--mcp-config" in args:
        url = json.loads(args[args.index("--mcp-config") + 1])["mcpServers"]["bom"]["url"]
        def rpc(method, params=None, id_=1):
            body = json.dumps({"jsonrpc": "2.0", "id": id_, "method": method, "params": params or {}}).encode()
            req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())["result"]
        rpc("initialize", {"protocolVersion": "2025-06-18"})
        names = [t["name"] for t in rpc("tools/list", id_=2)["tools"]]
        say("Let me check. ")
        out({"type": "assistant", "message": {"id": "msg_1", "content": [
            {"type": "text", "text": "Let me check. "},
            {"type": "tool_use", "id": "toolu_1", "name": "mcp__bom__current_time",
             "input": {"zone": "Europe/London"}},
        ]}})
        result = rpc("tools/call", {"name": "current_time", "arguments": {"zone": "Europe/London"}}, id_=3)
        say("It is " + result["content"][0]["text"] + ". Tools: " + ",".join(names))
    else:
        say("Plain answer to: " + user["message"]["content"][-1]["text"])

    out({"type": "result", "subtype": "success", "is_error": False, "result": "done",
         "usage": {"input_tokens": 10, "cache_read_input_tokens": 90, "output_tokens": 7}})
    '''
)

TOOLS = [{
    "name": "current_time",
    "description": "The current time.",
    "parameters": {"type": "object", "properties": {"zone": {"type": "string"}}},
}]


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture()
def fake_claude(tmp_path, monkeypatch):
    script = tmp_path / "claude_fake.py"
    script.write_text(FAKE_CLAUDE)
    launcher = tmp_path / "claude"
    launcher.write_text(f"#!/bin/sh\nexec {sys.executable} {script} \"$@\"\n")
    launcher.chmod(0o755)
    monkeypatch.setenv("CLAUDE_CODE_BIN", str(launcher))
    monkeypatch.setenv("FAKE_ARGS_OUT", str(tmp_path / "args.json"))
    # Must never reach the child: the plan, not a key, pays for this backend.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-should-not-pass")
    return tmp_path


async def _serve(provider: ClaudeCodeProvider, port: int):
    app = FastAPI()
    app.include_router(build_claude_code_router(provider, lambda: None, "127.0.0.1"), prefix="/api")
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.02)
    return server, task


async def _collect(stream):
    chunks = []
    async for chunk in stream:
        chunks.append(chunk)
    return chunks


@pytest.mark.anyio
async def test_a_skill_call_round_trips_through_one_claude_process(fake_claude):
    port = _free_port()
    provider = ClaudeCodeProvider(data_dir=fake_claude, bind_host="127.0.0.1", bind_port=port)
    server, task = await _serve(provider, port)
    try:
        convo = [Message("system", "You are Bom."), Message("user", "What time is it?")]
        first = await asyncio.wait_for(_collect(provider.stream(convo, tools=TOOLS, think="high")), 30)
        assert "".join(c.text for c in first) == "Let me check. "
        end = first[-1]
        assert end.done and [(c.id, c.name, c.arguments) for c in end.tool_calls] == [
            ("toolu_1", "current_time", {"zone": "Europe/London"})
        ]
        # The process is still there, waiting on Bom inside the MCP call.
        (turn,) = provider.turns
        assert turn.proc.returncode is None

        convo += [
            Message("assistant", "Let me check. ", tool_calls=end.tool_calls),
            Message("tool", "10:42", tool_call_id="toolu_1", tool_name="current_time"),
        ]
        second = await asyncio.wait_for(_collect(provider.stream(convo, tools=TOOLS)), 30)
        assert "".join(c.text for c in second) == "It is 10:42. Tools: current_time"
        assert second[-1].done and not second[-1].tool_calls
        assert second[-1].prompt_tokens == 100 and second[-1].meta == {"cache_read_tokens": 90}
        assert not provider.turns

        started = json.loads((fake_claude / "args.json").read_text())
        args = started["args"]
        # The unmodified binary, in print mode, with its own tools off and only
        # Bom's MCP server allowed -- and never handed an API key.
        assert args[0] == "-p" and args[args.index("--tools") + 1] == ""
        assert args[args.index("--allowedTools") + 1] == "mcp__bom"
        assert args[args.index("--effort") + 1] == "high"
        assert "--strict-mcp-config" in args and "--no-session-persistence" in args
        assert started["env_has_key"] is False
        assert started["cwd"].endswith("claude-code")
    finally:
        server.should_exit = True
        await task


@pytest.mark.anyio
async def test_a_turn_without_skills_is_plain_text(fake_claude):
    provider = ClaudeCodeProvider(data_dir=fake_claude, bind_host="127.0.0.1", bind_port=_free_port())
    chunks = await asyncio.wait_for(
        _collect(provider.stream([Message("system", "Title it."), Message("user", "Hello there")])), 30
    )
    assert "".join(c.text for c in chunks) == "Plain answer to: Hello there"
    args = json.loads((fake_claude / "args.json").read_text())["args"]
    assert "--mcp-config" not in args


@pytest.mark.anyio
async def test_not_signed_in_says_how_to_sign_in(fake_claude, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "noauth")
    provider = ClaudeCodeProvider(data_dir=fake_claude, bind_host="127.0.0.1", bind_port=_free_port())
    with pytest.raises(ProviderError, match="claude auth login"):
        await asyncio.wait_for(_collect(provider.stream([Message("user", "hi")])), 30)


@pytest.mark.anyio
async def test_status_reports_sign_in_without_reading_credentials(fake_claude, monkeypatch):
    provider = ClaudeCodeProvider(data_dir=fake_claude, bind_host="127.0.0.1", bind_port=1)
    status = await provider.auth_status(fresh=True)
    assert status == {"installed": True, "logged_in": True, "method": "claude.ai", "version": "9.9.9"}
    assert await provider.health()
    monkeypatch.setenv("FAKE_LOGGED_IN", "0")
    status = await provider.auth_status(fresh=True)
    assert status["installed"] and not status["logged_in"]


@pytest.mark.anyio
async def test_not_installed_is_not_configured(monkeypatch, tmp_path):
    monkeypatch.setenv("CLAUDE_CODE_BIN", str(tmp_path / "missing"))
    provider = ClaudeCodeProvider(data_dir=tmp_path, bind_host="127.0.0.1", bind_port=1)
    assert not provider.configured
    assert not await provider.health()
    with pytest.raises(ProviderError, match="isn't installed"):
        await _collect(provider.stream([Message("user", "hi")]))


def test_earlier_messages_ride_along_as_a_transcript():
    message = _user_message([
        Message("system", "ignored here"),
        Message("user", "first question"),
        Message("assistant", "first answer"),
        Message("user", "second question"),
    ])
    blocks = message["message"]["content"]
    assert "User: first question" in blocks[0]["text"] and "Assistant: first answer" in blocks[0]["text"]
    assert blocks[-1] == {"type": "text", "text": "second question"}


def test_the_bridge_only_answers_this_machine():
    from fastapi.testclient import TestClient

    provider = ClaudeCodeProvider(data_dir=__import__("pathlib").Path("/tmp"), bind_host="127.0.0.1", bind_port=1)
    app = FastAPI()
    app.include_router(build_claude_code_router(provider, lambda: None, "127.0.0.1"), prefix="/api")
    # TestClient's peer is "testclient", not a loopback address.
    response = TestClient(app).post("/api/claude-code/mcp/anything", json={"jsonrpc": "2.0", "id": 1, "method": "ping"})
    assert response.status_code == 404
