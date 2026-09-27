"""An Ollama on another machine on this network.

The second Ollama backend, "network": a GPU box in the next room, a desktop
serving the laptop, a home server. It speaks exactly what the local one does,
so it is the same provider class pointed somewhere else. What is here is the
part that is not the same: the address comes from a person, not from the
environment, so it is checked before anything is sent to it.

* **It has to be on this network.** The address must resolve to a private,
  loopback, link-local or CGNAT (Tailscale-style 100.64/10) address. A public
  address is refused: every prompt, file and memory in a conversation goes to
  whatever this points at, and "on my local network" is the promise the page
  makes. Someone who really wants a remote Ollama can set NETWORK_OLLAMA_URL in
  the environment, which is taken as given.
* **It has to answer as Ollama.** `/api/version` is asked before the address is
  kept, so a typo fails on the settings page, not on the next message.
* **Finding one** scans this machine's own /24 for the Ollama port. Only that:
  one subnet per interface, one port, short timeouts, and only the hosts that
  answer the handshake are asked anything.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from urllib.parse import urlparse

import httpx

DEFAULT_PORT = 11434

# Tailscale, and carrier-grade NAT generally. Not "private" to ipaddress, but
# it is how a lot of people reach the machine in the next room.
_CGNAT = ipaddress.ip_network("100.64.0.0/10")

_PROBE_TIMEOUT = httpx.Timeout(4.0, connect=3.0)
_SCAN_CONNECT = 0.5
_SCAN_WORKERS = 64


class AddressError(ValueError):
    """An address that cannot be used, with the sentence that says why."""


def normalize(url: str | None) -> str:
    """`192.168.1.20`, `gpu-box:11434` or a full URL, as `http://host:port`.

    Empty stays empty -- that is how the connection is taken back.
    """
    text = (url or "").strip()
    if not text:
        return ""
    if "://" not in text:
        text = f"http://{text}"
    parsed = urlparse(text)
    if parsed.scheme not in ("http", "https"):
        raise AddressError("Use an http:// or https:// address.")
    if parsed.username or parsed.password:
        raise AddressError("Leave the user name and password out of the address.")
    if parsed.query or parsed.fragment or parsed.path.strip("/"):
        raise AddressError("Give just the machine and port, like http://192.168.1.20:11434.")
    host = parsed.hostname
    if not host:
        raise AddressError("That address has no machine in it.")
    try:
        port = parsed.port or DEFAULT_PORT
    except ValueError as exc:
        raise AddressError("That port is not a number between 1 and 65535.") from exc
    shown = f"[{host}]" if ":" in host else host
    return f"{parsed.scheme}://{shown}:{port}"


def is_local_ip(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value.split("%", 1)[0])
    except ValueError:
        return False
    if address.version == 4 and address in _CGNAT:
        return True
    return address.is_private or address.is_loopback or address.is_link_local


async def check_local(url: str) -> None:
    """Refuse an address that is not on this network. Resolves names first,
    and every address a name resolves to has to be local -- a name that
    points both inside and outside is not trusted to pick the inside one."""
    host = urlparse(url).hostname or ""
    if is_local_ip(host):
        return
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        raise AddressError(
            f"{host} is on the internet, not your local network. Prompts would leave "
            "your network, so it is not accepted here."
        )
    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError) as exc:
        raise AddressError(f"No machine called {host!r} could be found on the network.") from exc
    found = {info[4][0] for info in infos}
    if not found or not all(is_local_ip(ip) for ip in found):
        raise AddressError(
            f"{host} resolves to an address outside your local network, so it is not "
            "accepted here."
        )


async def probe(url: str, *, transport: httpx.AsyncBaseTransport | None = None) -> dict:
    """Ask an address whether it is Ollama. Returns its version and models."""
    try:
        async with httpx.AsyncClient(
            base_url=url, timeout=_PROBE_TIMEOUT, transport=transport, follow_redirects=False
        ) as client:
            version = await client.get("/api/version")
            if version.status_code != 200:
                raise AddressError(f"Something answered at {url}, but it is not Ollama.")
            try:
                number = (version.json() or {}).get("version", "")
            except ValueError as exc:
                raise AddressError(f"Something answered at {url}, but it is not Ollama.") from exc
            tags = await client.get("/api/tags")
            try:
                models = (tags.json() or {}).get("models") or [] if tags.status_code == 200 else []
            except ValueError:
                models = []
    except httpx.ConnectError as exc:
        raise AddressError(
            f"Nothing answered at {url}. On that machine, Ollama has to listen on the "
            "network: set OLLAMA_HOST=0.0.0.0 and restart it, and allow port "
            f"{urlparse(url).port or DEFAULT_PORT} through its firewall."
        ) from exc
    except httpx.TimeoutException as exc:
        raise AddressError(f"{url} did not answer in time. Is the machine awake?") from exc
    except httpx.HTTPError as exc:
        raise AddressError(f"Could not talk to {url}: {exc}") from exc
    return {
        "url": url,
        "version": str(number or ""),
        "models": sorted(
            str(m.get("model") or m.get("name") or "") for m in models if isinstance(m, dict)
        ),
    }


def own_addresses() -> list[str]:
    """This machine's IPv4 addresses on local networks.

    The UDP "connect" sends nothing; it only asks the kernel which interface
    would carry traffic out, which is the one on the LAN.
    """
    found: set[str] = set()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe_socket:
            probe_socket.connect(("192.0.2.1", 9))
            found.add(probe_socket.getsockname()[0])
    except OSError:
        pass
    try:
        for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
            found.add(ip)
    except OSError:
        pass
    return sorted(
        ip for ip in found
        if is_local_ip(ip) and not ipaddress.ip_address(ip).is_loopback
    )


async def _open(host: str, port: int) -> bool:
    try:
        _, writer = await asyncio.wait_for(asyncio.open_connection(host, port), _SCAN_CONNECT)
    except (OSError, asyncio.TimeoutError):
        return False
    writer.close()
    try:
        await writer.wait_closed()
    except OSError:
        pass
    return True


async def discover(port: int = DEFAULT_PORT, *, addresses: list[str] | None = None) -> list[dict]:
    """Ollama servers on this machine's own subnets. Each: url, version,
    models, and whether it is this machine (which is the Local backend
    already, when Ollama here listens on the network)."""
    mine = addresses if addresses is not None else own_addresses()
    subnets = []
    for ip in mine[:2]:
        net = ipaddress.ip_network(f"{ip}/24", strict=False)
        if net not in subnets:
            subnets.append(net)
    hosts = [str(h) for net in subnets for h in net.hosts()]
    gate = asyncio.Semaphore(_SCAN_WORKERS)

    async def check(host: str) -> str | None:
        async with gate:
            return host if await _open(host, port) else None

    open_hosts = [h for h in await asyncio.gather(*(check(h) for h in hosts)) if h]
    found = []
    for host in open_hosts:
        url = f"http://{host}:{port}"
        try:
            info = await probe(url)
        except AddressError:
            continue
        found.append({**info, "self": host in mine})
    return found
