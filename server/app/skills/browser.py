"""The web, as a page at a time: Bom's own browser, and the user's.

Two sets of skills that read alike and are told apart by their names, because
the choice between them is the decision the model has to make:

* **Bom's browser** -- `open_page`, `read_page`, `act_on_page`, `view_page`.
  A private Chromium with its own profile, signed in to nothing. For anything
  that is about a page: an article, a price, a public form, a dev server.
  Runs like any other skill, under the ordinary approval switch.

* **The user's browser** -- `open_in_my_browser`, `read_my_browser`,
  `act_in_my_browser`. The browser they use themselves, with their accounts
  open in it. For the few things that need their signed-in account. Off until
  they pick a browser in Settings, and every call goes through the approval
  prompt whatever the switch says (`must_ask`), because a click in their mail
  is a click in their mail.

Neither will type a password: the descriptions say so, the system prompt says
so, and the honest path -- open the sign-in page in their browser and ask them
to sign in themselves -- is the one the model is pointed at.

A page comes back as numbered controls and text (browser/summary.py); the
model acts on a control by its number and gets the page back again after,
so a step costs one round rather than two.
"""

from __future__ import annotations

import re
from urllib.parse import urlsplit

from ..browser.chromium import BrowserError
from ..browser.mine import AutomationError, hand_off
from ..browser.service import Browsers
from ..browser.summary import format_page, one_line
from ..providers.base import Image
from .args import plain_text
from .skill import Pictured, Skill

ACTIONS = ("click", "type", "press", "select", "scroll", "back")

OWN_REQUIRES = (
    "a Chromium-based browser (Chrome, Chromium, Edge or Brave), or one fetched "
    "from Settings → Browser"
)
MINE_REQUIRES = "a browser picked in Settings → Browser"

_ACT_PARAMETERS = {
    "type": "object",
    "properties": {
        "action": {
            "type": "string",
            "enum": list(ACTIONS),
            "description": (
                "click: a control by number. type: text into a field by number "
                "(replaces what is there unless clear is false; enter presses Enter "
                "after). press: a key -- Enter, Tab, Escape, ArrowDown, PageDown... "
                "select: an option in a drop-down by its text. scroll: down or up, "
                "or to a control by number. back: the previous page."
            ),
        },
        "ref": {"type": "integer", "description": "The control's number from the last read."},
        "text": {"type": "string", "description": "For type: what to type."},
        "key": {"type": "string", "description": "For press: which key."},
        "value": {"type": "string", "description": "For select: the option's text or value."},
        "direction": {"type": "string", "enum": ["down", "up"], "description": "For scroll."},
        "enter": {"type": "boolean", "description": "For type: press Enter afterwards."},
        "clear": {"type": "boolean", "description": "For type: empty the field first (default true)."},
    },
    "required": ["action"],
}


_NON_WEB = re.compile(
    r"^(javascript|data|mailto|about|chrome|chrome-extension|blob|file|tel|sms|vbscript|ftp|ws|wss):",
    re.I,
)


def _local_host(host: str) -> bool:
    """A host on this machine or its own network, where http is the norm."""
    name = host.lower().strip("[]")
    if name in ("localhost", "0.0.0.0", "::1") or name.endswith((".localhost", ".test", ".local")):
        return True
    if name.startswith(("127.", "10.", "192.168.")):
        return True
    return name.startswith("172.") and name.split(".")[1].isdigit() and 16 <= int(name.split(".")[1]) <= 31


def clean_url(raw) -> str:
    """An address the browser may open. http(s) only; a bare host gets https,
    or http when it is this machine or its network (a dev server, say)."""
    text = plain_text(raw)
    if not text:
        raise BrowserError("Give me an address to open.")
    # A scheme with no "//" -- javascript:, data:, mailto: -- is not a bare
    # host missing its https://, and must not be made into one.
    if "://" not in text and _NON_WEB.match(text):
        raise BrowserError(f"Only http and https addresses can be opened, not {text.split(':', 1)[0]}:.")
    if "://" not in text:
        bare = text.lstrip("/")
        host = bare.split("/", 1)[0].split("@")[-1].rsplit(":", 1)[0] if not bare.startswith("[") else bare.split("]", 1)[0]
        text = ("http://" if _local_host(host) else "https://") + bare
    parts = urlsplit(text)
    if parts.scheme not in ("http", "https"):
        raise BrowserError(f"Only http and https addresses can be opened, not {parts.scheme}:.")
    if not parts.netloc:
        raise BrowserError(f"{text!r} is not an address I can open.")
    return text


def _int(value, name: str) -> int:
    try:
        return int(plain_text(value))
    except (TypeError, ValueError):
        raise BrowserError(f"{name} must be a number.") from None


async def _act(driver, action, ref, text, key, value, direction, enter, clear) -> str:
    """One action on either browser's driver. Returns what was done, in words."""
    action = plain_text(action).lower().strip()
    if action not in ACTIONS:
        raise BrowserError(f"{action!r} is not an action. Choose from: {', '.join(ACTIONS)}.")
    if action == "back":
        if not hasattr(driver, "back"):
            raise BrowserError("Going back is not possible in the user's browser; open the page you want.")
        await driver.back()
        return "Went back a page."
    if action == "scroll":
        where = plain_text(direction).lower() or "down"
        n = _int(ref, "ref") if ref not in (None, "") else 0
        await driver.scroll(ref=n, direction="up" if where == "up" else "down")
        return f"Scrolled to control [{n}]." if n else f"Scrolled {where}."
    if action == "press":
        name = plain_text(key) or plain_text(text) or "Enter"
        await driver.press(name)
        return f"Pressed {name}."
    n = _int(ref, "ref")
    if action == "click":
        await driver.click(n)
        return f"Clicked [{n}]."
    if action == "type":
        typed = plain_text(text) if text is not None else ""
        wipe = clear is None or str(clear).lower() not in ("false", "0", "no")
        hit_enter = enter is not None and str(enter).lower() in ("true", "1", "yes")
        await driver.type(n, typed, clear=wipe, enter=hit_enter)
        return f"Typed into [{n}]" + (" and pressed Enter." if hit_enter else ".")
    if action == "select":
        wanted = plain_text(value) or plain_text(text)
        if not wanted:
            raise BrowserError("Say which option to select, in `value`.")
        await driver.select(n, wanted)
        return f"Selected {wanted!r} in [{n}]."
    raise BrowserError(f"{action!r} is not an action.")


# -- Bom's own browser ----------------------------------------------------------


class _Own(Skill):
    """Shared by the four skills on Bom's browser."""

    surfaces = "browser"
    wants_session = True

    def __init__(self, browsers: Browsers, settings, **spec) -> None:
        super().__init__(requires=OWN_REQUIRES, **spec)
        self.browsers = browsers
        self.settings = settings
        # A read is the page itself: let it through whole.
        self.max_result_chars = int(settings.browser_text_chars) + 12_000

    @property
    def available(self) -> bool:
        return self.browsers.own_available

    def view_for(self, session_id: str) -> dict | None:
        return self.browsers.view(session_id)

    async def _page(self, session, tab, *, start: int = 0, lead: str | None = None) -> str:
        page = await tab.read(
            max_text=self.settings.browser_text_chars,
            max_elements=self.settings.browser_elements,
            start=start,
        )
        await self.browsers.record(session, tab, page)
        dialog, tab.dialog = tab.dialog, None
        return format_page(page, where="Bom's own browser", dialog=dialog, lead=lead)


class OpenPage(_Own):
    def __init__(self, browsers: Browsers, settings) -> None:
        super().__init__(
            browsers, settings,
            name="open_page",
            description=(
                "Open a web address in Bom's own browser -- a private browser with no "
                "accounts signed in, separate from the user's -- and read the page: its "
                "controls, numbered, and its text. Use it for anything that is about a "
                "page: an article, documentation, a price, a public form, a site or a "
                "local dev server you are checking. Then act_on_page by number, and "
                "read_page again. Not for anything behind the user's own login: that is "
                "open_in_my_browser, when they have set one up."
            ),
            parameters={
                "type": "object",
                "properties": {"url": {"type": "string", "description": "The address to open."}},
                "required": ["url"],
            },
        )

    async def use(self, session: str, url=None, **extra) -> str:
        try:
            address = clean_url(url or extra.get("address") or extra.get("href"))
            tab = await self.browsers.tab(session)
            async with tab.lock:
                await tab.navigate(address)
                return await self._page(session, tab)
        except BrowserError as exc:
            return str(exc)


class ReadPage(_Own):
    def __init__(self, browsers: Browsers, settings) -> None:
        super().__init__(
            browsers, settings,
            name="read_page",
            description=(
                "Read the page currently open in Bom's own browser: its controls, "
                "numbered so you can act on them, and its text. `start` reads on from "
                "that character of a long page's text. Read again after anything that "
                "may have changed the page."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "start": {"type": "integer", "description": "Character of the page text to read from."},
                },
            },
        )

    async def use(self, session: str, start=None, **extra) -> str:
        try:
            offset = _int(start, "start") if start not in (None, "") else 0
            tab = await self.browsers.tab(session)
            async with tab.lock:
                return await self._page(session, tab, start=max(0, offset))
        except BrowserError as exc:
            return str(exc)


class ActOnPage(_Own):
    def __init__(self, browsers: Browsers, settings) -> None:
        super().__init__(
            browsers, settings,
            name="act_on_page",
            description=(
                "Do one thing on the page open in Bom's own browser -- click a control, "
                "type into a field, press a key, pick an option, scroll, or go back -- "
                "naming controls by the numbers from the last read. The page is read "
                "again after and returned, so you can see what the action did. Never "
                "type a password, a one-time code or a card number: if a page wants "
                "one, ask the user to sign in themselves in their own browser."
            ),
            parameters=_ACT_PARAMETERS,
        )

    async def use(self, session: str, action=None, ref=None, text=None, key=None, value=None,
                  direction=None, enter=None, clear=None, **extra) -> str:
        try:
            tab = await self.browsers.tab(session)
            async with tab.lock:
                did = await _act(tab, action, ref, text, key, value, direction, enter, clear)
                return await self._page(session, tab, lead=did)
        except BrowserError as exc:
            return str(exc)


class ViewPage(_Own):
    def __init__(self, browsers: Browsers, settings) -> None:
        super().__init__(
            browsers, settings,
            name="view_page",
            description=(
                "Look at the page open in Bom's own browser as a picture, returned to "
                "you as an image. Use it when the layout matters -- a chart, a map, a "
                "design you are checking -- or when the text alone does not explain what "
                "is on screen. read_page is cheaper for words."
            ),
        )

    async def use(self, session: str, **extra) -> str:
        try:
            tab = await self.browsers.tab(session)
            async with tab.lock:
                page = await tab.read(max_text=400, max_elements=10)
                shot = await tab.screenshot(quality=80)
                await self.browsers.record(session, tab, page)
        except BrowserError as exc:
            return str(exc)
        said = (
            f"This is {one_line(page)}, as it looks in Bom's browser right now, "
            "1280px wide. Read the page for its text and controls; act on it by number."
        )
        return Pictured(said, [Image(name="page.jpg", mime="image/jpeg", data=shot)])


# -- the user's browser ---------------------------------------------------------


class _Mine(Skill):
    """Shared by the three skills on the user's browser."""

    surfaces = "browser"
    wants_session = True

    def __init__(self, browsers: Browsers, settings, **spec) -> None:
        super().__init__(requires=MINE_REQUIRES, **spec)
        self.browsers = browsers
        self.settings = settings
        self.max_result_chars = int(settings.browser_text_chars) + 12_000

    @property
    def must_ask(self) -> bool:
        # A step in the user's own signed-in browser is asked about every
        # time, whatever the global switch says. Their standing grants --
        # "allow in this chat", "always" -- still count: that is them saying so.
        return True

    @property
    def available(self) -> bool:
        return self.browsers.mine_choice() is not None

    def view_for(self, session_id: str) -> dict | None:
        return self.browsers.view(session_id)

    def _where(self) -> str:
        choice = self.browsers.mine_choice()
        return f"the user's own browser ({choice.name})" if choice else "the user's own browser"

    async def _page(self, session, driver, *, start: int = 0, lead: str | None = None) -> str:
        page = await driver.read(
            max_text=self.settings.browser_text_chars,
            max_elements=self.settings.browser_elements,
            start=start,
        )
        self.browsers.record_mine(session, page)
        return format_page(page, where=self._where(), lead=lead)

    def _unset(self) -> str:
        return "The user has not picked a browser for me to use. They can, in Settings → Browser."


class OpenInMyBrowser(_Mine):
    def __init__(self, browsers: Browsers, settings) -> None:
        super().__init__(
            browsers, settings,
            name="open_in_my_browser",
            description=(
                "Open a web address in the user's own browser -- the one they use, with "
                "their accounts signed in -- and read the page if the browser allows it. "
                "Only for what needs their signed-in account (their mail, a dashboard, an "
                "order, anything behind a login) or when they ask for it; everything else "
                "belongs in open_page. The user approves this first. If a page asks them "
                "to sign in, say so and let them do it themselves, then read again."
            ),
            parameters={
                "type": "object",
                "properties": {"url": {"type": "string", "description": "The address to open."}},
                "required": ["url"],
            },
        )

    async def use(self, session: str, url=None, **extra) -> str:
        choice = self.browsers.mine_choice()
        if choice is None:
            return self._unset()
        try:
            address = clean_url(url or extra.get("address") or extra.get("href"))
        except BrowserError as exc:
            return str(exc)
        driver = self.browsers.mine()
        if driver is not None and driver.scriptable:
            try:
                async with driver.lock:
                    await driver.open(address)
                    return await self._page(session, driver)
            except AutomationError as exc:
                # Opened the hard way, so the user still gets the page.
                problem = hand_off(address, choice)
                self.browsers.record_mine(session, None, address)
                if problem:
                    return f"{exc} And it could not be opened plainly either: {problem}"
                return (
                    f"Opened {address} in {choice.name}, but I cannot read it: {exc} "
                    "Ask the user what they see, or what to do next."
                )
        problem = hand_off(address, choice)
        if problem:
            return problem
        self.browsers.record_mine(session, None, address)
        return (
            f"Opened {address} in {choice.name}. Pages there cannot be read from here"
            + (" on this system" if not driver or not driver.scriptable else "")
            + ", so ask the user what they see or what they would like done next."
        )


class ReadMyBrowser(_Mine):
    def __init__(self, browsers: Browsers, settings) -> None:
        super().__init__(
            browsers, settings,
            name="read_my_browser",
            description=(
                "Read the page in the front tab of the user's own browser: its controls, "
                "numbered, and its text. `start` reads on from that character of a long "
                "page. Use it after the user has signed in or done something there, or "
                "to see what they are looking at when they ask. The user approves this."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "start": {"type": "integer", "description": "Character of the page text to read from."},
                },
            },
        )

    async def use(self, session: str, start=None, **extra) -> str:
        if self.browsers.mine_choice() is None:
            return self._unset()
        driver = self.browsers.mine()
        if driver is None or not driver.scriptable:
            return (
                f"Pages in {self._where()} cannot be read on this system; "
                "ask the user what they see."
            )
        try:
            offset = _int(start, "start") if start not in (None, "") else 0
            async with driver.lock:
                return await self._page(session, driver, start=max(0, offset))
        except (AutomationError, BrowserError) as exc:
            return str(exc)


class ActInMyBrowser(_Mine):
    def __init__(self, browsers: Browsers, settings) -> None:
        super().__init__(
            browsers, settings,
            name="act_in_my_browser",
            description=(
                "Do one thing in the front tab of the user's own browser -- click, type, "
                "press a key, pick an option, scroll -- by the numbers from read_my_browser. "
                "The page is read again after and returned. The user approves each step. "
                "Never type a password, a one-time code or a card number: ask the user to "
                "do that themselves."
            ),
            parameters=_ACT_PARAMETERS,
        )

    async def use(self, session: str, action=None, ref=None, text=None, key=None, value=None,
                  direction=None, enter=None, clear=None, **extra) -> str:
        if self.browsers.mine_choice() is None:
            return self._unset()
        driver = self.browsers.mine()
        if driver is None or not driver.scriptable:
            return f"Nothing can be done in {self._where()} from here on this system; ask the user to."
        try:
            async with driver.lock:
                did = await _act(driver, action, ref, text, key, value, direction, enter, clear)
                return await self._page(session, driver, lead=did)
        except (AutomationError, BrowserError) as exc:
            return str(exc)


def browser_skills(browsers: Browsers, settings) -> list[Skill]:
    """Every browser skill, Bom's own first."""
    return [
        OpenPage(browsers, settings),
        ReadPage(browsers, settings),
        ActOnPage(browsers, settings),
        ViewPage(browsers, settings),
        OpenInMyBrowser(browsers, settings),
        ReadMyBrowser(browsers, settings),
        ActInMyBrowser(browsers, settings),
    ]


OWN_SKILLS = frozenset({"open_page", "read_page", "act_on_page", "view_page"})
MINE_SKILLS = frozenset({"open_in_my_browser", "read_my_browser", "act_in_my_browser"})
