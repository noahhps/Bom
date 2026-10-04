"""Fetching a browser for Bom, when the machine has none.

Google publishes "Chrome for Testing": plain builds of Chrome, one per
platform, with no auto-update and no installer, made for exactly this kind of
use. Settings → Browser offers to fetch the current stable one into
`data/browser/engine/`, where find_engine looks before it looks at the
machine's own browsers.

Asked for, never automatic: it is a 150-odd megabyte download from Google's
servers, and the user should be the one who decides that is worth it. Progress
is reported so the button has something to say while it happens.
"""

from __future__ import annotations

import asyncio
import os
import platform
import shutil
import stat
import sys
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

import httpx

INDEX_URL = (
    "https://googlechromelabs.github.io/chrome-for-testing/"
    "last-known-good-versions-with-downloads.json"
)

#: Where each platform's build puts its binary inside the zip.
_BINARIES = {
    "mac-arm64": "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "mac-x64": "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "linux64": "chrome-linux64/chrome",
    "win64": "chrome-win64/chrome.exe",
}

_TIMEOUT = httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=10.0)


def platform_key() -> str | None:
    """Google's name for this machine, or None if there is no build for it."""
    machine = platform.machine().lower()
    if sys.platform == "darwin":
        return "mac-arm64" if machine in ("arm64", "aarch64") else "mac-x64"
    if sys.platform.startswith("linux"):
        return "linux64" if machine in ("x86_64", "amd64") else None
    if sys.platform.startswith("win"):
        return "win64" if machine in ("amd64", "x86_64") else None
    return None


def engine_dir(browser_dir: Path) -> Path:
    return browser_dir / "engine"


def installed_binary(browser_dir: Path) -> Path | None:
    """The fetched browser's binary, if a fetch has completed here."""
    base = engine_dir(browser_dir)
    for relative in _BINARIES.values():
        candidate = base / relative
        if candidate.is_file():
            return candidate
    return None


@dataclass
class Progress:
    state: str = "idle"  # idle | downloading | unpacking | done | failed
    received: int = 0
    total: int = 0
    version: str = ""
    error: str | None = None
    path: str | None = None

    def to_dict(self) -> dict:
        return {
            "state": self.state, "received": self.received, "total": self.total,
            "version": self.version, "error": self.error, "path": self.path,
        }


def pick_download(index: dict, key: str) -> tuple[str, str]:
    """The stable build's version and zip address for a platform."""
    stable = (index.get("channels") or {}).get("Stable") or {}
    version = str(stable.get("version") or "")
    for entry in (stable.get("downloads") or {}).get("chrome") or []:
        if entry.get("platform") == key and entry.get("url"):
            return version, str(entry["url"])
    raise ValueError(f"no Chrome for Testing build for {key}")


def extract(archive: Path, dest: Path) -> None:
    """Unzip, keeping the modes and symlinks a Mac app bundle depends on.

    `zipfile.extractall` writes a symlink as a file holding the link's target
    and drops every execute bit -- after which the app cannot start. So each
    entry is placed by hand, reading the Unix mode out of the zip's own header.
    """
    with zipfile.ZipFile(archive) as zf:
        for info in zf.infolist():
            name = info.filename
            if name.startswith("/") or ".." in Path(name).parts:
                continue
            target = dest / name
            if name.endswith("/"):
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            mode = (info.external_attr >> 16) & 0xFFFF
            if stat.S_ISLNK(mode):
                link_to = zf.read(info).decode("utf-8", "replace")
                if target.is_symlink() or target.exists():
                    target.unlink()
                os.symlink(link_to, target)
                continue
            with zf.open(info) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)
            if mode & 0o777:
                os.chmod(target, mode & 0o777)


class Installer:
    """One fetch at a time, with progress a status call can read."""

    def __init__(self, browser_dir: Path) -> None:
        self.browser_dir = browser_dir
        self.progress = Progress()
        self._task: asyncio.Task | None = None
        found = installed_binary(browser_dir)
        if found is not None:
            self.progress = Progress(state="done", path=str(found))

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    def start(self) -> Progress:
        if self.running:
            return self.progress
        key = platform_key()
        if key is None:
            self.progress = Progress(state="failed", error="There is no Chrome for Testing build for this machine.")
            return self.progress
        self.progress = Progress(state="downloading")
        self._task = asyncio.create_task(self._run(key))
        return self.progress

    async def _run(self, key: str) -> None:
        downloads = self.browser_dir / "downloads"
        archive = downloads / f"chrome-{key}.zip"
        try:
            downloads.mkdir(parents=True, exist_ok=True)
            async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True) as client:
                index = (await client.get(INDEX_URL)).raise_for_status().json()
                version, url = pick_download(index, key)
                self.progress.version = version
                async with client.stream("GET", url) as response:
                    response.raise_for_status()
                    self.progress.total = int(response.headers.get("content-length") or 0)
                    with open(archive, "wb") as out:
                        async for chunk in response.aiter_bytes(1 << 16):
                            out.write(chunk)
                            self.progress.received += len(chunk)
            self.progress.state = "unpacking"
            dest = engine_dir(self.browser_dir)
            # A fresh unpack each time; a half-extracted older copy on top of a
            # new one is how a browser ends up unable to start.
            await asyncio.to_thread(shutil.rmtree, dest, True)
            await asyncio.to_thread(extract, archive, dest)
            archive.unlink(missing_ok=True)
            found = installed_binary(self.browser_dir)
            if found is None:
                raise RuntimeError("the archive did not contain the browser where it was expected")
            self.progress.state = "done"
            self.progress.path = str(found)
        except asyncio.CancelledError:
            self.progress = Progress(state="failed", error="The download was stopped.")
            raise
        except Exception as exc:  # noqa: BLE001 -- reported on the button, not raised
            self.progress.state = "failed"
            self.progress.error = f"{type(exc).__name__}: {exc}"

    async def aclose(self) -> None:
        if self.running:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
