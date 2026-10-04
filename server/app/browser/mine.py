"""The user's own browser: the one they are signed in to, driven by Apple Events.

The point of it is the sessions. Bom's own browser knows nobody; this one has
the user's mail, their bank's dashboard, their order history, already open.
So it is driven, not copied: on macOS every real browser answers Apple Events,
and Safari and the Chromium family (Chrome, Edge, Brave, Arc, Dia, Chromium,
Vivaldi) will run a line of JavaScript in the front tab when asked -- which is
the same script Bom's browser runs, so a page reads the same in either.

Three things gate it, and all three are the user's, not ours:

* **the pick.** Nothing here runs until Settings → Browser names a browser.
  "Default" follows whatever macOS opens links with.
* **Automation.** The first Apple Event raises the system's own prompt
  ("Bom wants to control Safari"). A refusal is permanent until changed in
  System Settings, and every function here returns the reason as a sentence.
* **JavaScript from Apple Events.** Off in every browser until the user turns
  it on (Safari: Develop menu; the Chromium family: View → Developer). Until
  then a page can be opened in the browser but not read -- which is still
  useful, as a hand-off: "sign in here, then tell me".

Elsewhere than macOS there is no scripting layer worth the name, so the
user's browser is hand-off only: open the address, and let them take it.

Every action goes through the approval prompt, by construction of the skills
that call this -- see skills/browser.py. Reading is an action too.
"""

from __future__ import annotations

import asyncio
import json
import plistlib
import shutil
import subprocess
import sys
import webbrowser
from dataclasses import dataclass
from pathlib import Path

from . import page_script as js

#: Browsers that can be driven, by bundle id: the name macOS knows them by,
#: and which scripting dialect they speak. None means hand-off only.
KNOWN: dict[str, tuple[str, str | None]] = {
    "com.apple.Safari": ("Safari", "safari"),
    "com.google.Chrome": ("Google Chrome", "chrome"),
    "com.google.Chrome.canary": ("Google Chrome Canary", "chrome"),
    "org.chromium.Chromium": ("Chromium", "chrome"),
    "com.microsoft.edgemac": ("Microsoft Edge", "chrome"),
    "com.brave.Browser": ("Brave Browser", "chrome"),
    "company.thebrowser.Browser": ("Arc", "chrome"),
    "company.thebrowser.dia": ("Dia", "chrome"),
    "com.vivaldi.Vivaldi": ("Vivaldi", "chrome"),
    "org.mozilla.firefox": ("Firefox", None),
    "com.kagi.kagimacOS": ("Orion", None),
    "com.operasoftware.Opera": ("Opera", None),
}

#: Where apps live. The user's own folder too: some installers put them there.
_APP_DIRS = ("/Applications", str(Path.home() / "Applications"))

_LS_PLIST = Path.home() / "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist"

#: How long one Apple Event may take. Long, because the first one raises a
#: system prompt the user has to find and answer.
EVENT_TIMEOUT = 45.0
LOAD_TIMEOUT = 15.0

DEFAULT = "default"


@dataclass(frozen=True)
class Choice:
    """One browser the user could pick."""

    id: str          # bundle id, or "default"
    name: str        # what the menu says
    kind: str | None  # "safari" | "chrome" | None (hand-off only)
    installed: bool

    @property
    def scriptable(self) -> bool:
        return self.kind is not None and self.installed

    def to_dict(self) -> dict:
        return {"id": self.id, "name": self.name, "scriptable": self.scriptable, "installed": self.installed}


class AutomationError(RuntimeError):
    """The browser could not be driven, said the way the user should hear it."""


def supported() -> bool:
    """Whether this machine can drive a browser at all."""
    return sys.platform == "darwin"


def _app_path(name: str) -> Path | None:
    for folder in _APP_DIRS:
        candidate = Path(folder) / f"{name}.app"
        if candidate.exists():
            return candidate
    return None


def installed_browsers(app_path=_app_path) -> list[Choice]:
    """The browsers on this Mac, scriptable ones first."""
    found = [
        Choice(bundle, name, kind, True)
        for bundle, (name, kind) in KNOWN.items()
        if app_path(name) is not None
    ]
    found.sort(key=lambda c: (not c.scriptable, c.name.lower()))
    return found


def default_bundle(plist_path: Path = _LS_PLIST) -> str:
    """The bundle id macOS opens https links with. Safari when nothing says."""
    try:
        data = plistlib.loads(plist_path.read_bytes())
    except (OSError, ValueError):
        return "com.apple.Safari"
    for handler in data.get("LSHandlers", []) or []:
        if handler.get("LSHandlerURLScheme") == "https":
            bundle = handler.get("LSHandlerRoleAll") or handler.get("LSHandlerRoleViewer")
            if bundle:
                return str(bundle)
    return "com.apple.Safari"


def default_browser(plist_path: Path = _LS_PLIST, app_path=_app_path) -> Choice:
    """The default browser as a Choice -- known or not."""
    bundle = default_bundle(plist_path)
    if bundle in KNOWN:
        name, kind = KNOWN[bundle]
        return Choice(bundle, name, kind, app_path(name) is not None)
    # Something this file has not heard of: usable for a hand-off, by bundle.
    return Choice(bundle, bundle.rsplit(".", 1)[-1].title(), None, True)


def resolve(choice_id: str, **probes) -> Choice | None:
    """The user's pick as a Choice, or None when nothing is picked."""
    choice_id = (choice_id or "").strip()
    if not choice_id:
        return None
    if choice_id == DEFAULT:
        return default_browser(**probes)
    if choice_id in KNOWN:
        name, kind = KNOWN[choice_id]
        app_path = probes.get("app_path", _app_path)
        return Choice(choice_id, name, kind, app_path(name) is not None)
    return Choice(choice_id, choice_id, None, True)


# -- the driver -----------------------------------------------------------------

#: JavaScript for Automation, run by osascript with the app, a verb and one
#: argument. Kept to the handful of calls the two dialects share, with the
#: tab and the "run this" verb looked up per dialect.
_DRIVER = r"""
function run(argv) {
  var app = argv[0], cmd = argv[1], arg = argv[2] || "";
  var b = Application(app);
  var safari = (app === "Safari");
  function frontWindow() {
    if (b.windows.length === 0) {
      if (safari) { b.Document().make(); } else { b.Window().make(); }
    }
    return b.windows[0];
  }
  function tab() {
    var w = frontWindow();
    return safari ? w.currentTab : w.activeTab;
  }
  if (cmd === "ping") { return b.name(); }
  if (cmd === "open") {
    b.activate();
    var t = tab();
    t.url = arg;
    return "ok";
  }
  if (cmd === "url") { return String(tab().url()); }
  if (cmd === "eval") {
    var t2 = tab();
    var out = safari ? b.doJavaScript(arg, { in: t2 }) : t2.execute({ javascript: arg });
    return (out === undefined || out === null) ? "" : String(out);
  }
  throw new Error("unknown command " + cmd);
}
"""


def explain(stderr: str, name: str) -> str:
    """An osascript failure as the sentence the model should pass on."""
    text = (stderr or "").strip()
    low = text.lower()
    if "-1743" in text or "not authorized" in low or "not permitted" in low:
        return (
            f"macOS has not allowed Bom to control {name}. Allow it in System Settings → "
            "Privacy & Security → Automation (the prompt may be waiting on screen), then try again."
        )
    if "apple events" in low or "applescript is turned off" in low or "javascript through" in low:
        where = (
            "Safari → Develop → Allow JavaScript from Apple Events (turn on the Develop menu in "
            "Safari → Settings → Advanced first)"
            if name == "Safari"
            else f"{name} → View → Developer → Allow JavaScript from Apple Events"
        )
        return (
            f"{name} is not letting Bom run JavaScript in its pages yet. Turn on {where}, "
            "then try again. Until then I can open pages there but not read them."
        )
    if "-600" in text or "isn't running" in low or "is not running" in low:
        return f"{name} is not running. Open it and try again."
    if "-1728" in text:
        return f"{name} has no window to work in. Open one and try again."
    return f"{name} could not be driven: {text.splitlines()[-1] if text else 'no reason given'}"


class UserBrowser:
    """The user's browser, driven one Apple Event at a time."""

    def __init__(self, choice: Choice, *, timeout: float = EVENT_TIMEOUT) -> None:
        self.choice = choice
        self.timeout = timeout
        # One conversation with the browser at a time: it has one front tab.
        self.lock = asyncio.Lock()

    @property
    def name(self) -> str:
        return self.choice.name

    @property
    def scriptable(self) -> bool:
        return supported() and self.choice.scriptable

    async def _run(self, command: str, argument: str = "") -> str:
        if not supported():
            raise AutomationError("Driving your browser only works on macOS.")
        if not self.choice.scriptable:
            raise AutomationError(f"{self.name} cannot be driven; Bom can only open pages there.")
        try:
            proc = await asyncio.create_subprocess_exec(
                "osascript", "-l", "JavaScript", "-", self.name, command, argument,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except OSError as exc:
            raise AutomationError(f"osascript could not be started: {exc}")
        try:
            out, err = await asyncio.wait_for(proc.communicate(_DRIVER.encode()), self.timeout)
        except (asyncio.TimeoutError, TimeoutError):
            proc.kill()
            await proc.wait()
            raise AutomationError(
                f"{self.name} did not answer within {int(self.timeout)} seconds. A permission "
                "prompt may be waiting on screen; answer it and try again."
            )
        if proc.returncode != 0:
            raise AutomationError(explain(err.decode("utf-8", "replace"), self.name))
        return out.decode("utf-8", "replace").rstrip("\n")

    async def ping(self) -> str:
        return await self._run("ping")

    async def open(self, url: str) -> None:
        await self._run("open", url)
        await self.wait_loaded()

    async def url(self) -> str:
        return await self._run("url")

    async def evaluate(self, expression: str) -> str:
        return await self._run("eval", expression)

    async def wait_loaded(self, timeout: float = LOAD_TIMEOUT) -> bool:
        """Poll the page until it says it is complete. Tolerant: a page that
        never finishes is still a page the model can read."""
        await asyncio.sleep(0.6)
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            try:
                if (await self.evaluate(js.READY)).strip() == "complete":
                    await asyncio.sleep(0.3)
                    return True
            except AutomationError:
                raise
            await asyncio.sleep(0.4)
        return False

    async def read(self, *, max_text: int, max_elements: int, start: int = 0) -> dict:
        raw = await self.evaluate(js.read_script(max_text=max_text, max_elements=max_elements, start=start))
        try:
            page = json.loads(raw) if raw else {}
        except ValueError:
            page = {}
        return page if isinstance(page, dict) else {}

    async def click(self, ref: int) -> None:
        _check(await self.evaluate(js.CLICK % {"ref": ref}), ref)
        await self.wait_loaded(timeout=3.0)

    async def type(self, ref: int, text: str, *, clear: bool = True, enter: bool = False) -> None:
        _check(await self.evaluate(js.FOCUS % {"ref": ref, "clear": "true" if clear else "false"}), ref)
        if text:
            _check(await self.evaluate(js.TYPE % {"ref": ref, "text": js.js_string(text)}), ref)
        if enter:
            await self.press("Enter")
        else:
            await asyncio.sleep(0.2)

    async def press(self, key: str) -> None:
        await self.evaluate(js.PRESS % {"key": js.js_string(key)})
        await self.wait_loaded(timeout=3.0)

    async def select(self, ref: int, value: str) -> None:
        _check(await self.evaluate(js.SELECT % {"ref": ref, "value": js.js_string(value)}), ref)
        await asyncio.sleep(0.2)

    async def scroll(self, *, ref: int = 0, direction: str = "down") -> None:
        _check(await self.evaluate(js.SCROLL % {"ref": ref, "dy": -1 if direction == "up" else 1}), ref)
        await asyncio.sleep(0.2)


def _check(status: str, ref: int) -> None:
    status = (status or "").strip()
    if status == "stale":
        raise AutomationError(
            f"Control [{ref}] is no longer on the page -- it changed since you read it. "
            "Read the page again and use the new numbers."
        )
    if status == "not-a-select":
        raise AutomationError(f"Control [{ref}] is not a drop-down.")
    if status == "not-a-field":
        raise AutomationError(f"Control [{ref}] is not something that takes text.")
    if status == "no-such-option":
        raise AutomationError(f"Control [{ref}] has no option by that name.")


def hand_off(url: str, choice: Choice | None) -> str | None:
    """Open an address in the user's browser without driving it. Returns an
    error sentence, or None when the browser was told to open it."""
    try:
        if sys.platform == "darwin":
            if choice is not None and choice.id != DEFAULT and choice.id in KNOWN and choice.installed:
                subprocess.run(["open", "-a", choice.name, url], check=True, timeout=15,
                               capture_output=True)
            else:
                subprocess.run(["open", url], check=True, timeout=15, capture_output=True)
            return None
        if sys.platform.startswith("linux") and shutil.which("xdg-open"):
            subprocess.Popen(["xdg-open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return None
        if not webbrowser.open(url):
            return "No browser could be found to open it in."
        return None
    except (OSError, subprocess.SubprocessError) as exc:
        return f"The browser could not be opened: {exc}"
