"""The browsers: the page script's prose, the user's-browser pick, the fetched
engine, the skills' gating, the HTTP surface -- and, where a Chromium is at
hand, Bom's browser driven end to end."""

from __future__ import annotations

import http.server
import json
import os
import socketserver
import stat
import sys
import threading
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.browser import BROWSER_DEFAULTS, MINE_KEY, Browsers
from app.browser import mine, service
from app.browser.chromium import KEYS, find_engine, key_name
from app.browser.install import Installer, extract, installed_binary, pick_download, platform_key
from app.browser.page_script import js_string, read_script
from app.browser.summary import PREAMBLE, format_page
from app.config import Settings
from app.db import Database
from app.main import create_app
from app.skills.browser import MINE_SKILLS, OWN_SKILLS, browser_skills, clean_url
from app.skills.skill import Pictured
from app.store import Store


def _settings(tmp_path: Path, **over) -> Settings:
    base = dict(db_path=tmp_path / "b.db", browser_dir=tmp_path / "browser", auth_token="test_token")
    base.update(over)
    return Settings(**base)


@pytest.fixture
def store(tmp_path: Path) -> Store:
    return Store(Database(tmp_path / "store.db"))


# -- addresses ------------------------------------------------------------------


def test_clean_url_adds_a_scheme_and_prefers_http_at_home():
    assert clean_url("example.com/a?b=1") == "https://example.com/a?b=1"
    assert clean_url("localhost:5173") == "http://localhost:5173"
    assert clean_url("127.0.0.1:8080/x") == "http://127.0.0.1:8080/x"
    assert clean_url("192.168.1.9") == "http://192.168.1.9"
    assert clean_url("172.20.0.3:3000") == "http://172.20.0.3:3000"
    assert clean_url("172.40.0.3") == "https://172.40.0.3"
    assert clean_url("https://a.test/") == "https://a.test/"
    assert clean_url({"url": "example.org"}) == "https://example.org"


def test_clean_url_refuses_what_is_not_a_web_address():
    for bad in ("file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "", "https://"):
        with pytest.raises(Exception):
            clean_url(bad)


# -- the page, as prose ---------------------------------------------------------


def _page(**over) -> dict:
    page = {
        "url": "https://shop.test/",
        "title": "Test shop",
        "text": "Welcome to the shop. " * 10,
        "text_start": 0,
        "text_total": 2000,
        "elements": [
            {"ref": 1, "kind": "link", "name": "About us", "href": "https://shop.test/about"},
            {"ref": 2, "kind": "text", "name": "Search", "placeholder": "What are you after?"},
            {"ref": 3, "kind": "select", "name": "Colour", "value": "Red", "options": ["Red", "Green"], "more_options": 3},
            {"ref": 4, "kind": "checkbox", "name": "Gift wrap", "checked": False},
            {"ref": 5, "kind": "password", "name": "Password"},
            {"ref": 6, "kind": "button", "name": "Go", "disabled": True, "offscreen": True},
        ],
        "elements_total": 9,
        "scroll": {"y": 0, "height": 5000, "viewport": 900},
    }
    page.update(over)
    return page


def test_format_page_lists_controls_and_text_with_how_to_read_on():
    out = format_page(_page(), where="Bom's own browser", dialog="alert: hi", lead="Clicked [1].")
    assert out.startswith("Clicked [1].\n\nTest shop — https://shop.test/")
    assert "In Bom's own browser." in out
    assert "Scrolled to 0px of 5000px" in out
    assert "dialog, which was dismissed: alert: hi" in out
    assert PREAMBLE in out
    assert '[1] link "About us" → https://shop.test/about' in out
    assert '[2] text "Search" (placeholder: What are you after?)' in out
    assert '[3] select "Colour" = "Red" options: Red, Green (+3 more)' in out
    assert '[4] checkbox "Gift wrap" (not checked)' in out
    assert '[5] password "Password"' in out
    assert '[6] button "Go" (disabled) · off screen' in out
    assert "and 3 more controls further down" in out
    assert "Page text (characters 0–210 of 2000)" in out
    assert "Read on with start=210." in out


def test_format_page_says_when_there_is_nothing_to_read():
    out = format_page({"url": "about:blank", "elements": [], "text": ""}, where="x")
    assert "No controls on this page." in out
    assert "no readable text yet" in out


def test_read_script_carries_its_budgets_and_quotes_safely():
    script = read_script(max_text=1234, max_elements=56, start=78)
    assert "MAX_TEXT = 1234" in script and "MAX_ELEMENTS = 56" in script and "START = 78" in script
    assert read_script(max_text=1, max_elements=1).count("MAX_TEXT = 200") == 1
    assert js_string('he said "hi"\n</script>') == '"he said \\"hi\\"\\n</script>"'


def test_key_names_accept_the_spellings_a_model_uses():
    assert key_name("Enter") == "Enter" and key_name("return") == "Enter"
    assert key_name("esc") == "Escape" and key_name("page down") == "PageDown"
    assert key_name("down") == "ArrowDown"
    assert key_name("F13") is None
    assert all("windowsVirtualKeyCode" in spec for spec in KEYS.values())


# -- the user's browser ---------------------------------------------------------


def test_installed_browsers_are_scriptable_first(tmp_path: Path):
    present = {"Safari", "Firefox", "Dia"}
    found = mine.installed_browsers(app_path=lambda name: tmp_path if name in present else None)
    assert [c.name for c in found] == ["Dia", "Safari", "Firefox"]
    assert found[0].scriptable and not found[2].scriptable


def test_default_browser_is_read_from_launch_services(tmp_path: Path):
    import plistlib

    plist = tmp_path / "ls.plist"
    plist.write_bytes(plistlib.dumps({"LSHandlers": [
        {"LSHandlerURLScheme": "http", "LSHandlerRoleAll": "com.google.Chrome"},
        {"LSHandlerURLScheme": "https", "LSHandlerRoleAll": "com.google.Chrome"},
    ]}))
    chosen = mine.default_browser(plist, app_path=lambda name: tmp_path if name == "Google Chrome" else None)
    assert chosen.id == "com.google.Chrome" and chosen.name == "Google Chrome" and chosen.scriptable

    # Nothing written down means Safari; something unknown is hand-off only.
    assert mine.default_bundle(tmp_path / "missing.plist") == "com.apple.Safari"
    plist.write_bytes(plistlib.dumps({"LSHandlers": [
        {"LSHandlerURLScheme": "https", "LSHandlerRoleAll": "org.example.newbrowser"},
    ]}))
    odd = mine.default_browser(plist, app_path=lambda name: None)
    assert odd.id == "org.example.newbrowser" and not odd.scriptable and odd.installed


def test_resolve_turns_the_setting_into_a_choice(tmp_path: Path):
    assert mine.resolve("") is None
    picked = mine.resolve("com.apple.Safari", app_path=lambda name: tmp_path)
    assert picked.name == "Safari" and picked.kind == "safari" and picked.installed
    missing = mine.resolve("com.apple.Safari", app_path=lambda name: None)
    assert not missing.installed and not missing.scriptable


def test_osascript_failures_become_sentences_the_user_can_act_on():
    assert "Automation" in mine.explain("execution error: Not authorized to send Apple events to Safari. (-1743)", "Safari")
    chrome = mine.explain("Executing JavaScript through AppleScript is turned off.", "Google Chrome")
    assert "View → Developer → Allow JavaScript from Apple Events" in chrome
    safari = mine.explain("Allow JavaScript from Apple Events is not enabled", "Safari")
    assert "Develop" in safari
    assert "not running" in mine.explain("Application isn't running. (-600)", "Arc")
    assert "could not be driven" in mine.explain("something odd", "Arc")


@pytest.mark.asyncio
async def test_a_browser_that_cannot_be_scripted_is_not_driven():
    driver = mine.UserBrowser(mine.Choice("org.mozilla.firefox", "Firefox", None, True))
    assert not driver.scriptable
    with pytest.raises(mine.AutomationError):
        await driver.read(max_text=100, max_elements=5)


# -- the fetched engine ---------------------------------------------------------


def test_pick_download_finds_the_stable_build_for_a_platform():
    index = {"channels": {"Stable": {"version": "140.0.1", "downloads": {"chrome": [
        {"platform": "linux64", "url": "https://x/linux.zip"},
        {"platform": "mac-arm64", "url": "https://x/mac.zip"},
    ]}}}}
    assert pick_download(index, "mac-arm64") == ("140.0.1", "https://x/mac.zip")
    with pytest.raises(ValueError):
        pick_download(index, "win64")
    assert platform_key() in ("mac-arm64", "mac-x64", "linux64", "win64", None)


def test_extract_keeps_execute_bits_and_symlinks(tmp_path: Path):
    archive = tmp_path / "chrome.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        info = zipfile.ZipInfo("chrome-linux64/chrome")
        info.external_attr = (0o100755 << 16)
        zf.writestr(info, "#!/bin/sh\necho chrome\n")
        link = zipfile.ZipInfo("chrome-linux64/Current")
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        zf.writestr(link, "chrome")
        zf.writestr("chrome-linux64/../escape.txt", "no")
    dest = tmp_path / "engine"
    extract(archive, dest)
    binary = dest / "chrome-linux64" / "chrome"
    assert binary.is_file() and os.access(binary, os.X_OK)
    assert (dest / "chrome-linux64" / "Current").is_symlink()
    assert not (tmp_path / "escape.txt").exists()
    assert installed_binary(tmp_path) == binary


def test_installer_reports_a_finished_fetch_it_finds_on_disk(tmp_path: Path):
    binary = tmp_path / "engine" / "chrome-linux64" / "chrome"
    binary.parent.mkdir(parents=True)
    binary.write_text("x")
    assert Installer(tmp_path).progress.state == "done"
    assert Installer(tmp_path / "elsewhere").progress.state == "idle"


def test_find_engine_prefers_what_the_operator_named(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("CHROME_PATH", raising=False)
    named = tmp_path / "mybrowser"
    named.write_text("")
    assert find_engine(tmp_path / "nothing", str(named)).source == "BROWSER_PATH"
    fetched = tmp_path / "engine" / "chrome-linux64" / "chrome"
    fetched.parent.mkdir(parents=True)
    fetched.write_text("")
    assert find_engine(tmp_path, "").source == "downloaded"


# -- the service and the skills -------------------------------------------------


def test_the_pick_and_the_window_switch_are_kept(tmp_path: Path, store: Store):
    browsers = Browsers(_settings(tmp_path), store)
    assert browsers.mine_choice() is None
    browsers.set_mine("com.apple.Safari")
    assert browsers.mine_choice().name == "Safari"
    assert store.get_text_setting(MINE_KEY) == "com.apple.Safari"
    browsers.set_mine("")
    assert browsers.mine_choice() is None
    assert browsers.show_window() is False
    assert BROWSER_DEFAULTS == {"browser.show_window": False}


def test_skills_are_offered_only_when_their_browser_exists(tmp_path: Path, store: Store, monkeypatch):
    monkeypatch.setattr(service, "find_engine", lambda *a, **k: None)
    settings = _settings(tmp_path)
    browsers = Browsers(settings, store)
    skills = {s.name: s for s in browser_skills(browsers, settings)}
    assert set(skills) == OWN_SKILLS | MINE_SKILLS
    assert not any(skills[n].available for n in OWN_SKILLS)
    assert not any(skills[n].available for n in MINE_SKILLS)
    # The user's browser is asked about every call; Bom's own is not.
    assert all(skills[n].must_ask for n in MINE_SKILLS)
    assert not any(skills[n].must_ask for n in OWN_SKILLS)
    assert all(skills[n].surfaces == "browser" for n in skills)
    assert all(skills[n].wants_session for n in skills)

    browsers.set_mine("default")
    assert all(skills[n].available for n in MINE_SKILLS)
    engine = tmp_path / "engine-bin"
    engine.write_text("")
    monkeypatch.setattr(service, "find_engine", lambda *a, **k: __import__("app.browser.chromium", fromlist=["Engine"]).Engine(str(engine), "BROWSER_PATH"))
    assert all(skills[n].available for n in OWN_SKILLS)


@pytest.mark.asyncio
async def test_skills_say_what_is_missing_instead_of_failing(tmp_path: Path, store: Store, monkeypatch):
    monkeypatch.setattr(service, "find_engine", lambda *a, **k: None)
    settings = _settings(tmp_path)
    browsers = Browsers(settings, store)
    skills = {s.name: s for s in browser_skills(browsers, settings)}
    said = await skills["open_page"].use(session="s", url="example.com")
    assert "no browser on this machine" in said and "Settings → Browser" in said
    said = await skills["act_on_page"].use(session="s", action="click", ref=1)
    assert "no browser on this machine" in said
    said = await skills["open_in_my_browser"].use(session="s", url="example.com")
    assert "not picked a browser" in said
    said = await skills["read_my_browser"].use(session="s")
    assert "not picked a browser" in said
    said = await skills["open_page"].use(session="s", url="ftp://x")
    assert "Only http and https" in said


def test_the_http_surface(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(service, "find_engine", lambda *a, **k: None)
    app = create_app(_settings(tmp_path))
    client = TestClient(app, headers={"Authorization": "Bearer test_token"})
    assert TestClient(app).get("/api/browser").status_code == 401

    status = client.get("/api/browser").json()
    assert status["own"]["available"] is False and status["own"]["running"] is False
    assert status["own"]["install"]["state"] == "idle"
    assert status["mine"]["selected"] == "" and status["mine"]["choice"] is None
    assert status["mine"]["supported"] == (sys.platform == "darwin")

    status = client.patch("/api/browser", json={"mine": "default", "show_window": True}).json()
    assert status["mine"]["selected"] == "default"
    assert status["mine"]["choice"] is not None
    assert status["own"]["show_window"] is True
    assert client.get("/api/browser/view/nothing").json() == {"view": None}
    assert client.post("/api/browser/close").json()["own"]["running"] is False

    listed = {s["name"]: s for s in client.get("/api/skills").json()["skills"]}
    assert listed["open_in_my_browser"]["available"] is True
    assert listed["open_page"]["available"] is False
    assert "Settings → Browser" in listed["open_page"]["requires"]


def test_the_system_prompt_says_which_browser_is_for_what(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(service, "find_engine", lambda *a, **k: None)
    app = create_app(_settings(tmp_path))
    orchestrator = app.state.orchestrator
    # Nothing offered: nothing said.
    assert "Bom's own browser" not in orchestrator.build_system_prompt(None)[0]
    app.state.browsers.set_mine("default")
    prompt = orchestrator.build_system_prompt(None)[0]
    assert "The user's own browser" in prompt and "open_in_my_browser" in prompt
    assert "Bom has no browser of its own" in prompt
    assert "Never type a password" in prompt
    app.state.browsers.set_mine("")
    engine = tmp_path / "engine-bin"
    engine.write_text("")
    from app.browser.chromium import Engine
    monkeypatch.setattr(service, "find_engine", lambda *a, **k: Engine(str(engine), "BROWSER_PATH"))
    prompt = orchestrator.build_system_prompt(None)[0]
    assert "Bom's own browser (open_page" in prompt
    assert "Settings → Browser" in prompt


# -- the turn: a browser step reaches the panel ---------------------------------


class _Browsing:
    """Stands in for a browser skill in the turn loop: it surfaces a view."""

    from app.skills.skill import Skill as _Skill

    class Skill(_Skill):
        surfaces = "browser"
        wants_session = True

        def __init__(self) -> None:
            super().__init__(name="open_page", description="x")
            self.views: dict[str, dict] = {}

        def view_for(self, session_id):
            return self.views.get(session_id)

        async def use(self, session, url=None, **kw) -> str:
            self.views[session] = {"session_id": session, "where": "bom", "url": url, "title": "T", "shot": None, "at": 1}
            return "opened"


@pytest.mark.asyncio
async def test_a_browser_step_streams_a_browser_frame(tmp_path: Path):
    from app.orchestrator import Orchestrator
    from app.providers.base import Chunk, ToolCall
    from app.providers.router import ProviderRouter
    from app.skills.registry import Registry

    class Provider:
        name = model = "mock"
        rounds = 0

        async def stream(self, messages, *, think=None, tools=None):
            self.rounds += 1
            if self.rounds == 1:
                yield Chunk(done=True, tool_calls=(ToolCall(id="c1", name="open_page", arguments={"url": "https://x.test"}),))
            else:
                yield Chunk(text="Done.", done=True)

        async def embed(self, texts):
            return [[0.0] * 8 for _ in texts]

        async def health(self):
            return True

        async def sees_images(self):
            return False

    store = Store(Database(tmp_path / "turn.db"))
    registry = Registry()
    skill = _Browsing.Skill()
    registry.register(skill)
    provider = Provider()
    router = ProviderRouter.__new__(ProviderRouter)
    router.local = provider
    router.cloud = provider

    async def resolve(prefer=None):
        return type("Route", (), {"provider": provider, "reason": "local"})()

    router.resolve = resolve
    router.invalidate_health = lambda: None
    router.by_id = {"mock": provider}
    orchestrator = Orchestrator(_settings(tmp_path), store, router, registry)
    session = store.create_session()["id"]
    frames = []
    async for frame in orchestrator.run_turn(session, "open it"):
        frames.append(frame)
    joined = "".join(frames)
    assert "event: browser" in joined
    line = next(l for l in joined.splitlines() if l.startswith("data:") and '"where": "bom"' in l)
    view = json.loads(line[len("data:"):])
    assert view["url"] == "https://x.test" and view["session_id"] == session


# -- end to end, where a Chromium is at hand -----------------------------------

SITE = {
    "index.html": """<!doctype html><title>Test shop</title><main>
<h1>Welcome to the test shop</h1><nav><a href="/about.html">About us</a>
<a href="#" onclick="alert('hi');return false">Alert me</a></nav>
<form action="/result.html" method="get"><label>Search <input name="q" placeholder="What are you after?"></label>
<label>Colour <select name="c"><option>Red</option><option>Green</option><option value="b">Blue</option></select></label>
<label><input type="checkbox" name="gift"> Gift wrap</label>
<input type="password" name="pw" value="secret"><button type="submit">Go</button></form>
<p>""" + ("Lorem ipsum dolor sit amet. " * 400) + """</p>
<button id="bottom" onclick="document.title='clicked'">Bottom button</button></main>""",
    "about.html": "<!doctype html><title>About</title><main><h1>About the shop</h1><a href='/index.html'>Home</a></main>",
    "result.html": "<!doctype html><title>Results</title><main><h1>Results</h1><p id=q></p>"
                   "<script>document.getElementById('q').textContent='You searched: '+location.search</script></main>",
}


@pytest.fixture
def site(tmp_path: Path):
    root = tmp_path / "site"
    root.mkdir()
    for name, body in SITE.items():
        (root / name).write_text(body)

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=str(root), **k)

        def log_message(self, *a):
            pass

    server = socketserver.TCPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


def _engine_here(tmp_path: Path):
    return find_engine(tmp_path / "no-engine", os.environ.get("BROWSER_PATH", ""))


@pytest.mark.asyncio
async def test_boms_browser_end_to_end(tmp_path: Path, store: Store, site: str):
    if _engine_here(tmp_path) is None:
        pytest.skip("no Chromium on this machine (set BROWSER_PATH to run this)")
    settings = _settings(tmp_path, browser_path=os.environ.get("BROWSER_PATH", ""),
                         browser_text_chars=600, browser_elements=50)
    browsers = Browsers(settings, store)
    skills = {s.name: s for s in browser_skills(browsers, settings)}
    try:
        out = await skills["open_page"].use(session="s1", url=f"{site}/index.html")
        assert "Test shop — " in out and "Welcome to the test shop" in out
        assert '[1] link "About us"' in out and '[3] text "Search"' in out
        assert "password" in out and "secret" not in out, "a password's value must never be read out"
        assert "Read on with start=600." in out
        view = browsers.view("s1")
        assert view and view["where"] == "bom" and view["shot"] and view["title"] == "Test shop"

        out = await skills["act_on_page"].use(session="s1", action="type", ref=3, text="blue shoes")
        assert out.startswith("Typed into [3].") and '= "blue shoes"' in out
        out = await skills["act_on_page"].use(session="s1", action="select", ref=4, value="Blue")
        assert '[4] select "Colour" = "Blue"' in out
        out = await skills["act_on_page"].use(session="s1", action="click", ref=5)
        assert '[5] checkbox "Gift wrap" (checked)' in out
        out = await skills["act_on_page"].use(session="s1", action="click", ref=2)
        assert "dialog, which was dismissed: alert: hi" in out
        out = await skills["act_on_page"].use(session="s1", action="type", ref=3, text="hats", enter=True)
        assert "Results — " in out and "You searched: ?q=hats" in out
        out = await skills["act_on_page"].use(session="s1", action="back")
        assert out.startswith("Went back a page.") and "Test shop — " in out
        out = await skills["read_page"].use(session="s1", start=600)
        assert "characters 600–1200" in out
        out = await skills["act_on_page"].use(session="s1", action="scroll", direction="down")
        assert "Scrolled down." in out and "Scrolled to " in out and "Scrolled to 0px" not in out
        out = await skills["act_on_page"].use(session="s1", action="press", key="Home")
        assert out.startswith("Pressed Home.")
        pic = await skills["view_page"].use(session="s1")
        assert isinstance(pic, Pictured) and pic.images[0].mime == "image/jpeg" and len(pic.images[0].data) > 2000
        out = await skills["act_on_page"].use(session="s1", action="click", ref=1)
        assert "About — " in out
        out = await skills["act_on_page"].use(session="s1", action="click", ref=99)
        assert "no longer on the page" in out

        # Another conversation gets a tab of its own, with nothing in it.
        out = await skills["read_page"].use(session="s2")
        assert "about:blank" in out
        assert set(browsers._chromium.tabs) == {"s1", "s2"}
        assert browsers.status()["own"]["running"] and browsers.status()["own"]["tabs"] == 2

        out = await skills["open_page"].use(session="s1", url="http://127.0.0.1:1/")
        assert out.startswith("Could not open http://127.0.0.1:1/")
    finally:
        await browsers.aclose()
    assert not browsers.running
