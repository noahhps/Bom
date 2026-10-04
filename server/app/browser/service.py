"""The two browsers, as one thing the skills and the API share.

Holds Bom's own Chromium (started on the first page, quit when idle), the
user's browser as they picked it in Settings, the latest picture of each
conversation's tab for the panel in the client, and the fetch that gets a
browser onto a machine without one. The skills call in from the turn loop; the
router calls in from Settings; nothing else touches a process.
"""

from __future__ import annotations

import asyncio
import base64
import time
from pathlib import Path

from .chromium import (
    BROWSER_IDLE_SECONDS,
    TAB_IDLE_SECONDS,
    BrowserError,
    Chromium,
    Engine,
    Tab,
    find_engine,
)
from .install import Installer, platform_key
from .mine import Choice, UserBrowser, default_browser, installed_browsers, resolve, supported

#: Whether Bom's browser runs with a window the user can watch. Off: the
#: panel's screenshots are the window, and nothing pops up over their work.
BROWSER_DEFAULTS = {"browser.show_window": False}

#: The user's pick for their own browser: "", "default", or a bundle id.
MINE_KEY = "browser.mine"

#: How often idle tabs and an idle browser are looked for.
_SWEEP_SECONDS = 30.0


class Browsers:
    def __init__(self, settings, store) -> None:
        self.settings = settings
        self.store = store
        self.installer = Installer(Path(settings.browser_dir))
        self._chromium: Chromium | None = None
        self._launching = asyncio.Lock()
        self._views: dict[str, dict] = {}
        self._mine: UserBrowser | None = None
        self._sweeper: asyncio.Task | None = None

    # -- Bom's own browser ----------------------------------------------------

    def engine(self) -> Engine | None:
        return find_engine(Path(self.settings.browser_dir), self.settings.browser_path)

    @property
    def own_available(self) -> bool:
        return self.engine() is not None

    def show_window(self) -> bool:
        return self.store.get_settings(BROWSER_DEFAULTS)["browser.show_window"]

    @property
    def running(self) -> bool:
        return self._chromium is not None and self._chromium.alive

    @property
    def profile_dir(self) -> Path:
        return Path(self.settings.browser_dir) / "profile"

    async def _chromium_running(self) -> Chromium:
        async with self._launching:
            if self._chromium is not None and self._chromium.alive:
                return self._chromium
            if self._chromium is not None:
                # It died, or was quit: forget it and start clean.
                await self._chromium.stop()
                self._chromium = None
                self._views.clear()
            engine = self.engine()
            if engine is None:
                raise BrowserError(
                    "Bom has no browser on this machine. Install Chrome, Chromium, Edge or "
                    "Brave, or fetch one from Settings → Browser."
                )
            browser = Chromium(
                engine, self.profile_dir,
                headless=not self.show_window(),
                load_timeout=float(self.settings.browser_timeout),
            )
            await browser.start()
            self._chromium = browser
            if self._sweeper is None or self._sweeper.done():
                self._sweeper = asyncio.create_task(self._sweep())
            return browser

    async def tab(self, session_id: str) -> Tab:
        """The conversation's tab, with the browser started if it has to be."""
        browser = await self._chromium_running()
        return await browser.tab(session_id)

    async def close_own(self) -> None:
        if self._chromium is not None:
            await self._chromium.stop()
            self._chromium = None

    async def set_show_window(self, on: bool) -> None:
        """Flip the window setting. A running browser is quit so the next page
        opens the new way, rather than a setting that only applies some day."""
        self.store.set_settings({"browser.show_window": bool(on)})
        if self.running:
            await self.close_own()

    async def _sweep(self) -> None:
        try:
            while True:
                await asyncio.sleep(_SWEEP_SECONDS)
                browser = self._chromium
                if browser is None:
                    continue
                if not browser.alive:
                    await self.close_own()
                    continue
                now = time.monotonic()
                for key, tab in list(browser.tabs.items()):
                    if now - tab.last_used > TAB_IDLE_SECONDS:
                        await browser.close_tab(key)
                if not browser.tabs and now - browser.empty_since > BROWSER_IDLE_SECONDS:
                    await self.close_own()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 -- housekeeping never takes the server down
            pass

    # -- what the panel shows -------------------------------------------------

    async def record(self, session_id: str, tab: Tab, page: dict | None = None) -> dict:
        """Keep a picture of the conversation's tab, for the panel."""
        shot = None
        try:
            shot = base64.b64encode(await tab.screenshot(quality=60, scale=0.6)).decode("ascii")
        except Exception:  # noqa: BLE001 -- a missing picture is not a failed step
            shot = None
        url = (page or {}).get("url") or await tab.url()
        view = {
            "session_id": session_id,
            "where": "bom",
            "url": url,
            "title": (page or {}).get("title") or "",
            "shot": shot,
            "at": int(time.time() * 1000),
        }
        self._views[session_id] = view
        return view

    def record_mine(self, session_id: str, page: dict | None, url: str = "") -> dict:
        view = {
            "session_id": session_id,
            "where": "mine",
            "browser": self.mine_choice().name if self.mine_choice() else "",
            "url": (page or {}).get("url") or url,
            "title": (page or {}).get("title") or "",
            "shot": None,
            "at": int(time.time() * 1000),
        }
        self._views[session_id] = view
        return view

    def view(self, session_id: str) -> dict | None:
        return self._views.get(session_id)

    # -- the user's browser ---------------------------------------------------

    def mine_choice(self) -> Choice | None:
        return resolve(self.store.get_text_setting(MINE_KEY) or "")

    def set_mine(self, choice_id: str | None) -> None:
        value = (choice_id or "").strip()
        self.store.set_text_setting(MINE_KEY, value or None)
        self._mine = None

    def mine(self) -> UserBrowser | None:
        choice = self.mine_choice()
        if choice is None:
            return None
        if self._mine is None or self._mine.choice != choice:
            self._mine = UserBrowser(choice)
        return self._mine

    # -- status and shutdown --------------------------------------------------

    def status(self) -> dict:
        engine = self.engine()
        choice = self.mine_choice()
        mac = supported()
        return {
            "own": {
                "available": engine is not None,
                "engine": {"name": engine.name, "path": engine.path, "source": engine.source} if engine else None,
                "running": self.running,
                "tabs": len(self._chromium.tabs) if self._chromium else 0,
                "show_window": self.show_window(),
                "profile": str(self.profile_dir),
                "can_install": platform_key() is not None,
                "install": self.installer.progress.to_dict(),
            },
            "mine": {
                "supported": mac,
                "selected": self.store.get_text_setting(MINE_KEY) or "",
                "choice": choice.to_dict() if choice else None,
                "default": default_browser().to_dict() if mac else None,
                "choices": [c.to_dict() for c in installed_browsers()] if mac else [],
            },
        }

    async def aclose(self) -> None:
        if self._sweeper is not None:
            self._sweeper.cancel()
            await asyncio.gather(self._sweeper, return_exceptions=True)
            self._sweeper = None
        await self.close_own()
        await self.installer.aclose()
