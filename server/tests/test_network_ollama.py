"""An Ollama on another machine on the local network, as a second backend."""

from __future__ import annotations

import socket
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.providers import FALLBACK_ORDER, NETWORK, ProviderRouter, lan


def test_addresses_are_normalised():
    assert lan.normalize("192.168.1.20") == "http://192.168.1.20:11434"
    assert lan.normalize(" gpu-box:8080 ") == "http://gpu-box:8080"
    assert lan.normalize("https://10.0.0.5:11434/") == "https://10.0.0.5:11434"
    assert lan.normalize("http://[fd00::5]:11434") == "http://[fd00::5]:11434"
    assert lan.normalize("") == ""
    for bad in ("ftp://10.0.0.1", "http://u:p@10.0.0.1", "http://10.0.0.1:11434/api/chat",
                "http://10.0.0.1:99999", "http://"):
        with pytest.raises(lan.AddressError):
            lan.normalize(bad)


def test_what_counts_as_local():
    for ip in ("192.168.1.20", "10.0.0.5", "172.16.3.4", "127.0.0.1", "169.254.1.1",
               "100.101.102.103", "fd12::1"):
        assert lan.is_local_ip(ip), ip
    for ip in ("8.8.8.8", "1.1.1.1", "2606:4700::1111", "not-an-ip"):
        assert not lan.is_local_ip(ip), ip


@pytest.mark.asyncio
async def test_public_addresses_are_refused(monkeypatch):
    await lan.check_local("http://192.168.1.20:11434")
    with pytest.raises(lan.AddressError, match="internet"):
        await lan.check_local("http://8.8.8.8:11434")

    async def resolves_to(ips):
        async def fake(host, port, **kw):
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 0)) for ip in ips]
        return fake

    loop = __import__("asyncio").get_running_loop()
    monkeypatch.setattr(loop, "getaddrinfo", await resolves_to(["192.168.1.9"]))
    await lan.check_local("http://gpu-box:11434")
    # A name that points outside -- even partly -- is not trusted.
    monkeypatch.setattr(loop, "getaddrinfo", await resolves_to(["192.168.1.9", "52.1.2.3"]))
    with pytest.raises(lan.AddressError, match="outside"):
        await lan.check_local("http://sneaky.example:11434")


@pytest.mark.asyncio
async def test_probe_knows_ollama_from_something_else():
    def ollama(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/version":
            return httpx.Response(200, json={"version": "0.12.3"})
        return httpx.Response(200, json={"models": [{"model": "qwen3:14b"}, {"model": "gemma3:4b"}]})

    info = await lan.probe("http://10.0.0.5:11434", transport=httpx.MockTransport(ollama))
    assert info == {"url": "http://10.0.0.5:11434", "version": "0.12.3", "models": ["gemma3:4b", "qwen3:14b"]}

    other = httpx.MockTransport(lambda r: httpx.Response(404, text="nginx"))
    with pytest.raises(lan.AddressError, match="not Ollama"):
        await lan.probe("http://10.0.0.5:11434", transport=other)

    def refused(request):
        raise httpx.ConnectError("refused")

    with pytest.raises(lan.AddressError, match="OLLAMA_HOST=0.0.0.0"):
        await lan.probe("http://10.0.0.5:11434", transport=httpx.MockTransport(refused))


@pytest.mark.asyncio
async def test_discovery_scans_the_subnet_and_marks_this_machine(monkeypatch):
    listening = {"192.168.7.10", "192.168.7.44"}

    async def fake_open(host, port):
        return host in listening

    async def fake_probe(url, **kw):
        if "7.10" in url:
            return {"url": url, "version": "0.12.0", "models": ["llama3:8b"]}
        raise lan.AddressError("not ollama")

    monkeypatch.setattr(lan, "_open", fake_open)
    monkeypatch.setattr(lan, "probe", fake_probe)
    found = await lan.discover(addresses=["192.168.7.10"])
    assert found == [{"url": "http://192.168.7.10:11434", "version": "0.12.0",
                      "models": ["llama3:8b"], "self": True}]


@pytest.mark.asyncio
async def test_the_network_ollama_is_the_first_fallback(tmp_path: Path, monkeypatch):
    assert FALLBACK_ORDER[0] == NETWORK
    router = ProviderRouter(Settings(db_path=tmp_path / "r.db"), network_url="http://10.0.0.5:11434")

    async def down():
        return False

    async def up():
        return True

    monkeypatch.setattr(router.local, "health", down)
    monkeypatch.setattr(router.network, "health", up)
    route = await router.resolve()
    assert route.provider is router.network and route.provider.name == "ollama-network"
    await router.aclose()


@pytest.mark.asyncio
async def test_an_unset_network_ollama_is_never_healthy(tmp_path: Path):
    router = ProviderRouter(Settings(db_path=tmp_path / "r.db"), network_url="")
    assert not router.network.configured
    assert await router.network.health() is False
    assert await router.network.list_models() == []
    await router.aclose()


@pytest.fixture
def client(tmp_path: Path, monkeypatch) -> TestClient:
    async def ok(url):
        if "8.8.8.8" in url:
            raise lan.AddressError("8.8.8.8 is on the internet, not your local network.")

    async def probe(url, **kw):
        return {"url": url, "version": "0.12.3", "models": ["llama3.1:8b", "qwen3:14b"]}

    monkeypatch.setattr(lan, "check_local", ok)
    monkeypatch.setattr(lan, "probe", probe)
    settings = Settings(db_path=tmp_path / "n.db", auth_token="t")
    return TestClient(create_app(settings), headers={"Authorization": "Bearer t"})


def test_connecting_and_disconnecting_through_the_api(client: TestClient, tmp_path: Path):
    ids = [p["id"] for p in client.get("/api/models").json()["providers"]]
    assert ids[:2] == ["local", "network"]
    network = next(p for p in client.get("/api/models").json()["providers"] if p["id"] == "network")
    assert network["configured"] is False and network["url"] == ""

    r = client.put("/api/providers/network/url", json={"url": "192.168.1.20"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["url"] == "http://192.168.1.20:11434" and body["configured"] is True
    assert body["version"] == "0.12.3"
    # Switched to a model that machine has, rather than one pulled only here.
    assert body["model"] == "llama3.1:8b"

    bad = client.put("/api/providers/network/url", json={"url": "8.8.8.8"})
    assert bad.status_code == 400 and "internet" in bad.json()["detail"]
    assert client.put("/api/providers/network/url", json={"url": "ftp://x"}).status_code == 400

    status = client.get("/api/status").json()
    assert status["network"]["url"] == "http://192.168.1.20:11434"

    # Kept across a restart.
    again = TestClient(create_app(Settings(db_path=tmp_path / "n.db", auth_token="t")),
                       headers={"Authorization": "Bearer t"})
    assert again.get("/api/status").json()["network"]["url"] == "http://192.168.1.20:11434"

    off = client.put("/api/providers/network/url", json={"url": ""}).json()
    assert off["configured"] is False and off["url"] == ""


def test_discovery_route(client: TestClient, monkeypatch):
    async def fake_discover(port=11434, **kw):
        return [{"url": "http://192.168.1.44:11434", "version": "0.12.3", "models": ["x"], "self": False}]

    monkeypatch.setattr(lan, "discover", fake_discover)
    body = client.get("/api/providers/network/discover").json()
    assert body["servers"][0]["url"] == "http://192.168.1.44:11434"
    assert "scanned" in body
