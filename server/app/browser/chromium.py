"""Bom's own browser: a Chromium of its own, driven over the DevTools protocol.

Its own, in two senses. It is a separate process with a separate profile under
`data/browser/`, so nothing in it is signed in and nothing it does touches the
browser the user reads their mail in. And it is Bom's rather than the model's:
the model is handed a page at a time, as text, and acts through a handful of
verbs; the process, the tabs and the screenshots the user watches it by stay
here.

One browser per server, one tab per conversation. A conversation's tab is made
the first time it opens a page and closed when it has sat unused for a while;
the browser itself quits once it has no tabs left, and comes back on the next
page. Headless unless the user asks to watch the window -- the screenshot the
panel shows after every step is the window for most purposes.

The engine is whatever Chromium is on the machine: Chrome, Chromium, Edge or
Brave where they are usually installed, BROWSER_PATH (or CHROME_PATH) when the
operator says, or the copy of Chrome for Testing that Settings can fetch (see
install.py). Nothing is bundled.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import shutil
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from ..render import CHROMIUM_NAMES, CHROMIUM_PATHS
from . import page_script as js
from .cdp import CDP, CDPError
from .install import installed_binary

#: The window, and so the screenshot. Desktop-ish: wide enough that a site
#: serves its desktop layout, small enough that a picture of it reads.
WIDTH, HEIGHT = 1280, 900

#: How long the process may take to announce its DevTools address.
BOOT_TIMEOUT = 25.0
#: After a click or a keystroke, how long to watch for a navigation before
#: deciding there was none.
SETTLE_SECONDS = 0.6
#: A tab unused this long is closed; a browser with no tabs quits.
TAB_IDLE_SECONDS = 15 * 60
BROWSER_IDLE_SECONDS = 3 * 60

_DEVTOOLS_LINE = re.compile(r"DevTools listening on (ws://\S+)")

#: Keys a model may press, as the protocol wants them.
KEYS: dict[str, dict] = {
    "Enter": {"key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "text": "\r"},
    "Tab": {"key": "Tab", "code": "Tab", "windowsVirtualKeyCode": 9},
    "Escape": {"key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27},
    "Backspace": {"key": "Backspace", "code": "Backspace", "windowsVirtualKeyCode": 8},
    "Delete": {"key": "Delete", "code": "Delete", "windowsVirtualKeyCode": 46},
    "Space": {"key": " ", "code": "Space", "windowsVirtualKeyCode": 32, "text": " "},
    "ArrowUp": {"key": "ArrowUp", "code": "ArrowUp", "windowsVirtualKeyCode": 38},
    "ArrowDown": {"key": "ArrowDown", "code": "ArrowDown", "windowsVirtualKeyCode": 40},
    "ArrowLeft": {"key": "ArrowLeft", "code": "ArrowLeft", "windowsVirtualKeyCode": 37},
    "ArrowRight": {"key": "ArrowRight", "code": "ArrowRight", "windowsVirtualKeyCode": 39},
    "PageUp": {"key": "PageUp", "code": "PageUp", "windowsVirtualKeyCode": 33},
    "PageDown": {"key": "PageDown", "code": "PageDown", "windowsVirtualKeyCode": 34},
    "Home": {"key": "Home", "code": "Home", "windowsVirtualKeyCode": 36},
    "End": {"key": "End", "code": "End", "windowsVirtualKeyCode": 35},
}

#: The spellings a model uses for those keys.
KEY_ALIASES = {
    "return": "Enter", "enter": "Enter", "tab": "Tab", "esc": "Escape", "escape": "Escape",
    "backspace": "Backspace", "delete": "Delete", "del": "Delete", "space": "Space",
    "up": "ArrowUp", "down": "ArrowDown", "left": "ArrowLeft", "right": "ArrowRight",
    "arrowup": "ArrowUp", "arrowdown": "ArrowDown", "arrowleft": "ArrowLeft",
    "arrowright": "ArrowRight", "pageup": "PageUp", "pagedown": "PageDown",
    "home": "Home", "end": "End",
}


def key_name(name: str) -> str | None:
    """A key as the model spelt it, as the protocol names it; None if unknown."""
    text = (name or "").strip()
    if text in KEYS:
        return text
    return KEY_ALIASES.get(text.lower().replace(" ", ""))


class BrowserError(RuntimeError):
    """Something the model should be told in a sentence, not a traceback."""


class StaleRef(BrowserError):
    """The numbered control is gone: the page changed since it was read."""

    def __init__(self, ref: int) -> None:
        super().__init__(
            f"Control [{ref}] is no longer on the page -- it changed since you read it. "
            "Read the page again and use the new numbers."
        )


@dataclass(frozen=True)
class Engine:
    """A Chromium binary and where it came from."""

    path: str
    source: str  # BROWSER_PATH | CHROME_PATH | downloaded | installed

    @property
    def name(self) -> str:
        stem = Path(self.path).name
        return stem[:-4] if stem.lower().endswith(".exe") else stem


def find_engine(browser_dir: Path | None = None, explicit: str = "") -> Engine | None:
    """The Chromium Bom's browser will run, or None.

    Order: what the operator named, then the copy Settings downloaded, then
    whatever is installed. The downloaded copy outranks an installed Chrome
    because it was fetched for exactly this and nothing else updates it.
    """
    for value, source in ((explicit, "BROWSER_PATH"), (os.environ.get("CHROME_PATH", ""), "CHROME_PATH")):
        value = (value or "").strip()
        if value and Path(value).exists():
            return Engine(value, source)
    if browser_dir is not None:
        got = installed_binary(browser_dir)
        if got is not None:
            return Engine(str(got), "downloaded")
    for path in CHROMIUM_PATHS:
        if Path(path).exists():
            return Engine(path, "installed")
    for name in CHROMIUM_NAMES:
        found = shutil.which(name)
        if found:
            return Engine(found, "installed")
    return None


class Chromium:
    """One running browser process and the connection to it."""

    def __init__(
        self, engine: Engine, profile_dir: Path, *, headless: bool = True,
        load_timeout: float = 20.0,
    ) -> None:
        self.engine = engine
        self.profile_dir = profile_dir
        self.headless = headless
        self.load_timeout = load_timeout
        self.process: asyncio.subprocess.Process | None = None
        self.cdp: CDP | None = None
        self.tabs: dict[str, Tab] = {}
        self._drain: asyncio.Task | None = None
        self.started_at = 0.0
        self.empty_since = time.monotonic()

    @property
    def alive(self) -> bool:
        return (
            self.process is not None
            and self.process.returncode is None
            and self.cdp is not None
            and self.cdp.connected
        )

    def _args(self) -> list[str]:
        args = [
            self.engine.path,
            "--remote-debugging-port=0",
            f"--user-data-dir={self.profile_dir}",
            f"--window-size={WIDTH},{HEIGHT}",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-sync",
            "--disable-extensions",
            "--disable-background-networking",
            "--disable-component-update",
            "--mute-audio",
            "--hide-scrollbars",
            # Chromium keeps the profile's cookie key in the system keychain
            # and asks for it with a dialog; a throwaway key in memory instead.
            "--use-mock-keychain",
            "--password-store=basic",
        ]
        if self.headless:
            args += ["--headless=new", "--disable-gpu"]
        args.append("about:blank")
        return args

    async def start(self) -> None:
        self.profile_dir.mkdir(parents=True, exist_ok=True)
        port_file = self.profile_dir / "DevToolsActivePort"
        port_file.unlink(missing_ok=True)
        try:
            self.process = await asyncio.create_subprocess_exec(
                *self._args(),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
                env=_clean_env(),
            )
        except OSError as exc:
            raise BrowserError(f"The browser at {self.engine.path} could not be started: {exc}")
        url = await self._devtools_url(port_file)
        self.cdp = CDP(url)
        try:
            await self.cdp.connect()
        except Exception as exc:  # noqa: BLE001
            await self.stop()
            raise BrowserError(f"Could not connect to the browser: {exc}")
        # Nothing the model does may put a file on the disk.
        try:
            await self.cdp.send("Browser.setDownloadBehavior", {"behavior": "deny"})
        except CDPError:
            pass
        self.cdp.listen(self._on_event)
        self.started_at = time.monotonic()
        self.empty_since = time.monotonic()

    async def _devtools_url(self, port_file: Path) -> str:
        """The address the process prints on boot, or writes in its profile."""
        assert self.process is not None and self.process.stderr is not None
        stderr = self.process.stderr
        deadline = time.monotonic() + BOOT_TIMEOUT
        while time.monotonic() < deadline:
            try:
                line = await asyncio.wait_for(stderr.readline(), max(0.1, deadline - time.monotonic()))
            except (asyncio.TimeoutError, TimeoutError):
                break
            if not line:
                break
            hit = _DEVTOOLS_LINE.search(line.decode("utf-8", "replace"))
            if hit:
                self._drain = asyncio.create_task(_drain(stderr))
                return hit.group(1)
            if port_file.exists():
                break
        # Some builds write the file before (or instead of) printing the line.
        for _ in range(20):
            if port_file.exists():
                try:
                    port, path = port_file.read_text().split()[:2]
                    self._drain = asyncio.create_task(_drain(stderr))
                    return f"ws://127.0.0.1:{port}{path}"
                except ValueError:
                    pass
            if self.process.returncode is not None:
                break
            await asyncio.sleep(0.25)
        await self.stop()
        raise BrowserError(
            f"The browser at {self.engine.path} started but never announced its "
            "DevTools address. It may not be a Chromium, or another copy may be "
            "holding the profile."
        )

    def _on_event(self, method: str, params: dict, session_id: str | None) -> None:
        if method == "Target.detachedFromTarget":
            sid = params.get("sessionId")
            for key, tab in list(self.tabs.items()):
                if tab.session_id == sid:
                    tab.dead = True
                    self.tabs.pop(key, None)
            if not self.tabs:
                self.empty_since = time.monotonic()
            return
        if session_id is None:
            return
        for tab in self.tabs.values():
            if tab.session_id == session_id:
                tab.on_event(method, params)
                return

    async def tab(self, key: str) -> "Tab":
        """The tab for a conversation, made if it has none."""
        found = self.tabs.get(key)
        if found is not None and not found.dead:
            return found
        assert self.cdp is not None
        made = await self.cdp.send("Target.createTarget", {"url": "about:blank"})
        target_id = made["targetId"]
        attached = await self.cdp.send("Target.attachToTarget", {"targetId": target_id, "flatten": True})
        tab = Tab(self, target_id, attached["sessionId"])
        await tab.prepare()
        self.tabs[key] = tab
        return tab

    async def close_tab(self, key: str) -> None:
        tab = self.tabs.pop(key, None)
        if tab is None:
            return
        tab.dead = True
        if self.cdp is not None and self.cdp.connected:
            try:
                await self.cdp.send("Target.closeTarget", {"targetId": tab.target_id}, timeout=5)
            except CDPError:
                pass
        if not self.tabs:
            self.empty_since = time.monotonic()

    async def stop(self) -> None:
        """Quit, politely then not."""
        for tab in self.tabs.values():
            tab.dead = True
        self.tabs.clear()
        if self.cdp is not None and self.cdp.connected:
            try:
                await self.cdp.send("Browser.close", timeout=3)
            except CDPError:
                pass
            await self.cdp.close()
        if self.process is not None and self.process.returncode is None:
            try:
                await asyncio.wait_for(self.process.wait(), 3)
            except (asyncio.TimeoutError, TimeoutError):
                self.process.terminate()
                try:
                    await asyncio.wait_for(self.process.wait(), 3)
                except (asyncio.TimeoutError, TimeoutError):
                    self.process.kill()
                    await self.process.wait()
        if self._drain is not None:
            self._drain.cancel()
            await asyncio.gather(self._drain, return_exceptions=True)
            self._drain = None


class Tab:
    """One page, in one conversation."""

    def __init__(self, browser: Chromium, target_id: str, session_id: str) -> None:
        self.browser = browser
        self.target_id = target_id
        self.session_id = session_id
        self.lock = asyncio.Lock()
        self.dead = False
        self.last_used = time.monotonic()
        self.navigations = 0
        self.loaded = asyncio.Event()
        self.loaded.set()
        #: The last alert/confirm/prompt the page raised, to tell the model.
        self.dialog: str | None = None

    async def _send(self, method: str, params: dict | None = None, **kw) -> dict:
        if self.dead or self.browser.cdp is None:
            raise BrowserError("This conversation's tab is gone. Open the page again.")
        return await self.browser.cdp.send(method, params, session_id=self.session_id, **kw)

    async def prepare(self) -> None:
        await self._send("Page.enable")
        await self._send("Runtime.enable")
        await self._send(
            "Emulation.setDeviceMetricsOverride",
            {"width": WIDTH, "height": HEIGHT, "deviceScaleFactor": 1, "mobile": False},
        )

    def on_event(self, method: str, params: dict) -> None:
        if method == "Page.frameNavigated" and not params.get("frame", {}).get("parentId"):
            self.navigations += 1
            self.loaded.clear()
        elif method == "Page.loadEventFired":
            self.loaded.set()
        elif method == "Page.javascriptDialogOpening":
            kind = params.get("type", "alert")
            self.dialog = f"{kind}: {params.get('message', '')}".strip()
            # Dismissed, not answered: a prompt box is not something a model
            # gets to type into. `beforeunload` is accepted so the page can go.
            asyncio.create_task(
                self._send("Page.handleJavaScriptDialog", {"accept": kind == "beforeunload"})
            )
        elif method == "Inspector.targetCrashed":
            self.dead = True

    # -- the verbs ----------------------------------------------------------

    async def navigate(self, url: str) -> None:
        self.last_used = time.monotonic()
        self.loaded.clear()
        result = await self._send("Page.navigate", {"url": url})
        if result.get("errorText"):
            raise BrowserError(f"Could not open {url}: {result['errorText']}.")
        await self._wait_loaded()

    async def _wait_loaded(self) -> bool:
        try:
            await asyncio.wait_for(self.loaded.wait(), self.browser.load_timeout)
            await asyncio.sleep(0.3)
            return True
        except (asyncio.TimeoutError, TimeoutError):
            return False

    async def settle(self) -> None:
        """After an action: if it started a navigation, wait for the page."""
        before = self.navigations
        await asyncio.sleep(SETTLE_SECONDS)
        if self.navigations != before or not self.loaded.is_set():
            await self._wait_loaded()

    async def evaluate(self, expression: str):
        result = await self._send(
            "Runtime.evaluate",
            {"expression": expression, "returnByValue": True, "awaitPromise": True},
        )
        if result.get("exceptionDetails"):
            detail = result["exceptionDetails"]
            text = (detail.get("exception") or {}).get("description") or detail.get("text") or "error"
            raise BrowserError(f"The page's script failed: {text.splitlines()[0]}")
        return (result.get("result") or {}).get("value")

    async def read(self, *, max_text: int, max_elements: int, start: int = 0) -> dict:
        self.last_used = time.monotonic()
        raw = await self.evaluate(js.read_script(max_text=max_text, max_elements=max_elements, start=start))
        try:
            page = json.loads(raw) if isinstance(raw, str) else {}
        except ValueError:
            page = {}
        if not isinstance(page, dict):
            page = {}
        return page

    async def _locate(self, ref: int) -> dict:
        raw = await self.evaluate(js.LOCATE % {"ref": ref})
        if not raw:
            raise StaleRef(ref)
        return json.loads(raw)

    async def click(self, ref: int) -> None:
        self.last_used = time.monotonic()
        box = await self._locate(ref)
        if box["w"] < 1 or box["h"] < 1:
            await self.evaluate(js.CLICK % {"ref": ref})
        else:
            x, y = max(0.0, min(WIDTH - 1.0, box["x"])), max(0.0, min(HEIGHT - 1.0, box["y"]))
            await self._send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y})
            await self._send(
                "Input.dispatchMouseEvent",
                {"type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1},
            )
            await self._send(
                "Input.dispatchMouseEvent",
                {"type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1},
            )
        await self.settle()

    async def type(self, ref: int, text: str, *, clear: bool = True, enter: bool = False) -> None:
        self.last_used = time.monotonic()
        status = await self.evaluate(js.FOCUS % {"ref": ref, "clear": "true" if clear else "false"})
        if status == "stale":
            raise StaleRef(ref)
        if text:
            await self._send("Input.insertText", {"text": text})
        if enter:
            await self.press("Enter")
        else:
            await self.settle()

    async def press(self, key: str) -> None:
        self.last_used = time.monotonic()
        name = key_name(key)
        if name is None:
            raise BrowserError(
                f"{key!r} is not a key I can press. Choose from: " + ", ".join(KEYS) + "."
            )
        spec = KEYS[name]
        down = {"type": "keyDown" if "text" in spec else "rawKeyDown", **spec}
        await self._send("Input.dispatchKeyEvent", down)
        await self._send("Input.dispatchKeyEvent", {"type": "keyUp", **{k: v for k, v in spec.items() if k != "text"}})
        await self.settle()

    async def select(self, ref: int, value: str) -> None:
        self.last_used = time.monotonic()
        status = await self.evaluate(js.SELECT % {"ref": ref, "value": js.js_string(value)})
        _check_status(status, ref)
        await self.settle()

    async def scroll(self, *, ref: int = 0, direction: str = "down") -> None:
        self.last_used = time.monotonic()
        dy = -1 if direction == "up" else 1
        status = await self.evaluate(js.SCROLL % {"ref": ref, "dy": dy})
        _check_status(status, ref)
        await asyncio.sleep(0.25)

    async def back(self) -> None:
        self.last_used = time.monotonic()
        history = await self._send("Page.getNavigationHistory")
        index = history.get("currentIndex", 0)
        entries = history.get("entries") or []
        if index <= 0 or index >= len(entries):
            raise BrowserError("There is no page to go back to.")
        self.loaded.clear()
        await self._send("Page.navigateToHistoryEntry", {"entryId": entries[index - 1]["id"]})
        await self._wait_loaded()

    async def screenshot(self, *, quality: int = 70, scale: float = 1.0) -> bytes:
        """The window as a JPEG. `scale` shrinks it: the panel's copy travels
        on every step and need not be the full 1280px the model looks at."""
        self.last_used = time.monotonic()
        params: dict = {"format": "jpeg", "quality": quality}
        if scale < 1.0:
            params["clip"] = {"x": 0, "y": 0, "width": WIDTH, "height": HEIGHT, "scale": scale}
        result = await self._send("Page.captureScreenshot", params, timeout=20)
        return base64.b64decode(result.get("data", ""))

    async def url(self) -> str:
        try:
            return str(await self.evaluate("location.href") or "")
        except BrowserError:
            return ""


def _check_status(status, ref: int) -> None:
    if status == "stale":
        raise StaleRef(ref)
    if status == "not-a-select":
        raise BrowserError(f"Control [{ref}] is not a drop-down; click it or type into it instead.")
    if status == "not-a-field":
        raise BrowserError(f"Control [{ref}] is not something that takes text.")
    if status == "no-such-option":
        raise BrowserError(f"Control [{ref}] has no option by that name. Read the page for its options.")


def _clean_env() -> dict[str, str]:
    """The browser's environment, without this app's secrets."""
    drop = {"AUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "SEARCH_API_KEY",
            "BOM_RELAY_KEY", "IMAGE_GEN_API_KEY"}
    env = {k: v for k, v in os.environ.items() if k not in drop}
    if sys.platform == "linux" and "DISPLAY" not in env:
        # Headless needs no display; a headed run on a server without one
        # would fail either way, with a clearer message from Chromium itself.
        pass
    return env


async def _drain(stream: asyncio.StreamReader) -> None:
    """Keep reading a process's chatter so the pipe never fills and blocks it."""
    try:
        while await stream.read(65536):
            pass
    except (asyncio.CancelledError, Exception):  # noqa: BLE001
        pass
