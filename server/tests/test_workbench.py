"""The Code view's workbench: terminals and the project preview."""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.workbench import Terminals, _is_local


@pytest.fixture(autouse=True)
def plain_shell(monkeypatch):
    """A shell with no profile to read, so the tests do not depend on this
    machine's dotfiles."""
    monkeypatch.setenv("SHELL", "/bin/sh")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-secret-value")


@pytest.fixture
def base(tmp_path: Path) -> Path:
    folder = tmp_path / "home"
    folder.mkdir()
    return folder.resolve()


@pytest.fixture
def site(base: Path) -> Path:
    root = base / "site"
    (root / "js").mkdir(parents=True)
    (root / "index.html").write_text("<!doctype html><h1>Hello</h1><script type=module src=js/app.js></script>")
    (root / "js" / "app.js").write_text("console.log('hi')\n")
    (root / ".git").mkdir()
    (root / ".git" / "config").write_text("[core]\n")
    return root


async def _until(queue: asyncio.Queue, needle: str, timeout: float = 10.0) -> str:
    seen = ""
    async def read() -> str:
        nonlocal seen
        while needle not in seen:
            kind, value = await queue.get()
            if kind == "output":
                seen += value
        return seen
    return await asyncio.wait_for(read(), timeout)


@pytest.mark.asyncio
async def test_a_terminal_runs_a_shell_in_the_project(site: Path):
    terminals = Terminals()
    term = terminals.open(site, 100, 30)
    queue = term.attach()
    try:
        await term.write("pwd; echo sum-$((20+22)); echo key=${ANTHROPIC_API_KEY:-none}\n")
        # Waited for by what the commands print, not what was typed: the
        # terminal echoes the line itself first.
        await _until(queue, "key=none")
        assert str(site) in term.buffer and "sum-42" in term.buffer
        assert "sk-secret-value" not in term.buffer, "Bom's own secrets stay out"
        assert [t.id for t in terminals.in_folder(site)] == [term.id]
    finally:
        terminals.close(term.id)
    kind, code = await asyncio.wait_for(queue.get(), 5)
    while kind != "exit":
        kind, code = await asyncio.wait_for(queue.get(), 5)
    assert not term.alive and terminals.get(term.id) is None


@pytest.mark.asyncio
async def test_a_shell_that_exits_says_so(site: Path):
    terminals = Terminals()
    term = terminals.open(site)
    queue = term.attach()
    await term.write("exit 3\n")
    async def ended():
        while True:
            kind, value = await queue.get()
            if kind == "exit":
                return value
    assert await asyncio.wait_for(ended(), 10) == 3
    terminals.close_all()


def test_only_this_machine_may_open_a_terminal():
    local = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))
    remote = SimpleNamespace(client=SimpleNamespace(host="192.168.1.20"))
    assert _is_local(local) and not _is_local(remote)


@pytest.fixture
def client(tmp_path: Path, base: Path):
    settings = Settings(db_path=tmp_path / "api.db", auth_token="t", workspace_roots=(base,))
    # Entered, so every request and socket shares one event loop, as they do
    # in the server: a shell is read on the loop that started it.
    with TestClient(create_app(settings), headers={"Authorization": "Bearer t"}) as client:
        yield client


def test_the_terminal_socket_checks_the_token_first(client, site):
    with client.websocket_connect("/api/terminal") as ws:
        ws.send_json({"token": "wrong", "root": str(site)})
        said = ws.receive_json()
        assert said["type"] == "error" and "rejected" in said["message"]


def test_the_terminal_socket_streams_a_shell_and_reattaches(client, site):
    with client.websocket_connect("/api/terminal") as ws:
        ws.send_json({"token": "t", "root": str(site), "cols": 90, "rows": 20})
        ready = ws.receive_json()
        assert ready["type"] == "ready" and ready["root"] == str(site)
        ws.send_json({"type": "input", "data": "echo over-$((6*7))\n"})
        seen = ""
        while "over-42" not in seen:
            message = ws.receive_json()
            seen += message.get("data", "")
        term_id = ready["id"]

    listed = client.get("/api/terminals", params={"root": str(site)}).json()["terminals"]
    assert [t["id"] for t in listed] == [term_id] and listed[0]["alive"]

    # A new socket on the same id gets the same shell, and what it printed.
    with client.websocket_connect("/api/terminal") as ws:
        ws.send_json({"token": "t", "id": term_id})
        assert ws.receive_json()["id"] == term_id
        assert "over-42" in ws.receive_json()["data"]

    assert client.delete(f"/api/terminals/{term_id}").status_code == 200
    assert client.get("/api/terminals", params={"root": str(site)}).json()["terminals"] == []
    assert client.delete(f"/api/terminals/{term_id}").status_code == 404


def test_the_preview_serves_the_project_and_nothing_else(client, site, base):
    opened = client.post("/api/workspace/preview", json={"root": str(site)}).json()
    assert opened["entry"] == "index.html" and opened["base"].startswith("/api/preview/")
    anon = TestClient(client.app)  # an iframe sends no token
    page = anon.get(opened["base"])
    assert page.status_code == 200 and "<h1>Hello</h1>" in page.text
    assert page.headers["access-control-allow-origin"] == "*"
    script = anon.get(opened["base"] + "js/app.js")
    assert script.status_code == 200 and script.headers["content-type"].startswith("text/javascript")
    assert anon.get(opened["base"] + ".git/config").status_code == 404
    assert anon.get(opened["base"] + "../site/index.html").status_code in (200, 404)
    assert anon.get(opened["base"] + "%2e%2e/%2e%2e/etc/passwd").status_code == 404
    assert anon.get("/api/preview/not-a-key/index.html").status_code == 404
    assert client.post("/api/workspace/preview", json={"root": "/"}).status_code == 400
