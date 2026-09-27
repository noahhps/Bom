"""Pictures of the work, so a model that can see can look at what it made.

A model writes a page or a wireframe as text and never sees it drawn. The
design check reads the source for what can be measured; this draws it, so a
vision model can judge what cannot -- balance, rhythm, whether the thing looks
finished.

Everything is drawn as one 1024×1024 "stage": a page that holds the work,
scaled to fit. Two engines can draw a stage, both already on the machine or
not at all:

* **a Chromium browser** (Chrome, Chromium, Edge, Brave -- or CHROME_PATH),
  run headless with scripts off and every host name unresolvable, so nothing
  on the page reaches the network;
* **Quick Look** on a Mac (`qlmanage`), which renders HTML with WebKit, runs
  no scripts and fetches nothing. It draws a 1024px-wide viewport and keeps a
  square of it -- which is why the stage is that size.

Neither is a dependency to install. Where there is no engine the view skill
is simply not offered.

A wireframe is drawn by the client from its layers (client/src/lib/
wireframe.js). The server cannot run that, so `wireframe_html` below follows
the same rules -- the same kit, the same component shapes -- closely enough to
judge a layout by. It is labelled approximate wherever it is shown.
"""

from __future__ import annotations

import asyncio
import base64
import html as html_lib
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

STAGE = 1024
TIMEOUT_SECONDS = 25.0

# -- engines -------------------------------------------------------------------

_CHROMES = (
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
)
_CHROME_NAMES = ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable",
                 "microsoft-edge", "brave-browser")


class _Chrome:
    name = "chromium"

    def __init__(self, path: str) -> None:
        self.path = path

    async def shoot(self, page: Path, out_dir: Path) -> Path | None:
        shot = out_dir / "shot.png"
        args = [
            self.path, "--headless=new", "--disable-gpu", "--hide-scrollbars",
            "--no-first-run", "--no-default-browser-check", "--mute-audio",
            f"--user-data-dir={out_dir / 'profile'}",
            f"--window-size={STAGE},{STAGE}",
            "--blink-settings=scriptEnabled=false",
            # Nothing on the page may reach the network: the picture is of
            # what the page holds, and a render is not a reason to send the
            # user's address to whatever host a model wrote into it.
            "--host-resolver-rules=MAP * ~NOTFOUND",
            f"--screenshot={shot}",
            page.as_uri(),
        ]
        return shot if await _run(args) and shot.exists() else None


class _QuickLook:
    name = "quicklook"

    def __init__(self, path: str) -> None:
        self.path = path

    async def shoot(self, page: Path, out_dir: Path) -> Path | None:
        ok = await _run([self.path, "-t", "-s", str(STAGE), "-o", str(out_dir), str(page)])
        shot = out_dir / f"{page.name}.png"
        return shot if ok and shot.exists() else None


async def _run(args: list[str]) -> bool:
    try:
        proc = await asyncio.create_subprocess_exec(
            *args, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL
        )
    except (OSError, ValueError):
        return False
    try:
        await asyncio.wait_for(proc.wait(), TIMEOUT_SECONDS)
    except (asyncio.TimeoutError, TimeoutError):
        proc.kill()
        return False
    return True


def find_engine():
    """The engine this machine can draw with, or None."""
    configured = os.environ.get("CHROME_PATH", "").strip()
    if configured and Path(configured).exists():
        return _Chrome(configured)
    for path in _CHROMES:
        if Path(path).exists():
            return _Chrome(path)
    for name in _CHROME_NAMES:
        found = shutil.which(name)
        if found:
            return _Chrome(found)
    if sys.platform == "darwin":
        found = shutil.which("qlmanage")
        if found:
            return _QuickLook(found)
    return None


class Renderer:
    """Draws a stage page to PNG bytes with whatever engine is here."""

    def __init__(self, engine=None) -> None:
        self.engine = engine if engine is not None else find_engine()

    @property
    def available(self) -> bool:
        return self.engine is not None

    async def draw(self, stage_html: str) -> bytes | None:
        if self.engine is None:
            return None
        with tempfile.TemporaryDirectory(prefix="bom-render-") as tmp:
            folder = Path(tmp)
            page = folder / "stage.html"
            page.write_text(stage_html, encoding="utf-8")
            shot = await self.engine.shoot(page, folder)
            return shot.read_bytes() if shot is not None else None


# -- stages ----------------------------------------------------------------------

_BOARD = "#E9ECF2"
_LABEL = "font:600 13px -apple-system, 'Helvetica Neue', Arial, sans-serif;color:#5B677A"

DESKTOP_WIDTH = 1280
PHONE = (390, 844)


def _style(css: str) -> str:
    """A style attribute, escaped: font stacks carry quotes of their own."""
    return 'style="' + html_lib.escape(css, quote=True) + '"'


def _stage(body: str) -> str:
    return (
        "<!doctype html><html><head><meta charset='utf-8'><style>"
        f"html,body{{margin:0;width:{STAGE}px;height:{STAGE}px;overflow:hidden;background:{_BOARD}}}"
        "</style></head><body>" + body + "</body></html>"
    )


def _window(page: str, width: int, height: int, scroll: int) -> str:
    """The page in a frame `width` wide, showing `height` of it from `scroll`
    down. Scripts are off in the frame whatever the engine: the picture is
    of the page as written, and the two engines should agree."""
    source = html_lib.escape(page, quote=True)
    outer = _style(f"position:relative;width:{width}px;height:{height}px;overflow:hidden;background:#fff")
    inner = _style(
        f"position:absolute;left:0;top:-{scroll}px;width:{width}px;height:{height + scroll}px;border:0"
    )
    return f'<div {outer}><iframe sandbox="" srcdoc="{source}" {inner}></iframe></div>'


def page_stage(page: str, device: str = "desktop", scroll: int = 0) -> str:
    """A web page at desktop width, or as two consecutive phone screens."""
    scroll = max(0, int(scroll))
    if device == "mobile":
        width, height = PHONE
        gap, label = 48, 28
        total_w, total_h = width * 2 + gap, height + label
        scale = min((STAGE - 32) / total_w, (STAGE - 32) / total_h)
        left = (STAGE - total_w * scale) / 2
        screens = "".join(
            f"<div {_style(f'position:absolute;left:{n * (width + gap)}px;top:0')}>"
            f"<div {_style(f'{_LABEL};height:{label}px')}>{'Top' if n == 0 else 'Scrolled'} "
            f"· {scroll + n * height}px</div>"
            f"<div {_style('box-shadow:0 0 0 1px #C8CED8')}>"
            + _window(page, width, height, scroll + n * height)
            + "</div></div>"
            for n in range(2)
        )
        box = _style(
            f"position:absolute;left:{left:.1f}px;top:16px;width:{total_w}px;height:{total_h}px;"
            f"transform:scale({scale:.4f});transform-origin:0 0"
        )
        return _stage(f"<div {box}>{screens}</div>")
    scale = STAGE / DESKTOP_WIDTH
    box = _style(
        f"width:{DESKTOP_WIDTH}px;height:{DESKTOP_WIDTH}px;transform:scale({scale:.4f});"
        "transform-origin:0 0"
    )
    return _stage(f"<div {box}>" + _window(page, DESKTOP_WIDTH, DESKTOP_WIDTH, scroll) + "</div>")


# -- wireframes, drawn the way the client draws them ------------------------------

_MONO = "'DM Mono', ui-monospace, SFMono-Regular, Menlo, monospace"
WIRE = {
    "bg": "#FFFFFF", "surface": "#F4F6FA", "line": "#D3DAE6", "strong": "#A9B5C8",
    "text": "#0F172A", "muted": "#5B677A", "accent": "#1F4FD8", "onAccent": "#FFFFFF",
    "radius": 3, "head": _MONO, "body": _MONO, "mono": _MONO, "headWeight": 700,
    "headCase": "none",
}
DEFAULT_THEME = {
    "background": "#FFFFFF", "surface": "#F4F6FA", "text": "#14171F", "muted": "#5F6B7D",
    "accent": "#1F4FD8", "line": "#E1E6EE",
    "heading_font": "Inter, 'Helvetica Neue', Arial, system-ui, sans-serif",
    "body_font": "Inter, 'Helvetica Neue', Arial, system-ui, sans-serif",
    "heading_weight": 650, "heading_case": "none", "radius": 10,
}
ICONS = {
    "menu": "☰", "search": "⌕", "heart": "♥", "star": "★", "user": "◉", "bell": "◔",
    "cart": "⊕", "home": "⌂", "settings": "⚙", "close": "✕", "plus": "+", "arrow": "→",
    "back": "←", "check": "✓", "mail": "✉", "play": "▶", "share": "⤴", "more": "⋯",
    "filter": "⧩", "calendar": "▦",
}
_COLOUR = re.compile(r"^(#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\([0-9.,%\s/+-]{3,60}\)|[a-zA-Z]{3,24})$")


def _ink_on(colour: str) -> str:
    hit = re.match(r"^#([0-9a-f]{3}|[0-9a-f]{6})", colour or "", re.I)
    if not hit:
        return "#FFFFFF"
    h = hit.group(1)
    if len(h) == 3:
        h = "".join(c * 2 for c in h)

    def lin(c: float) -> float:
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (lin(int(h[i:i + 2], 16) / 255) for i in (0, 2, 4))
    return "#111111" if 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 else "#FFFFFF"


def palette(doc: dict) -> dict:
    if doc.get("fidelity") != "styled":
        return dict(WIRE)
    t = {**DEFAULT_THEME, **(doc.get("theme") or {})}
    return {
        "bg": t["background"], "surface": t["surface"], "line": t["line"],
        "strong": t["muted"], "text": t["text"], "muted": t["muted"],
        "accent": t["accent"], "onAccent": _ink_on(t["accent"]), "radius": t["radius"],
        "head": t["heading_font"], "body": t["body_font"], "mono": _MONO,
        "headWeight": t["heading_weight"],
        "headCase": "uppercase" if t.get("heading_case") == "upper" else "none",
    }


def _c(value, fallback):
    text = str(value or "").strip()
    return text if text and (_COLOUR.match(text) or text == "transparent") else fallback


def _n(value, fallback=0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _box(x, y, w, h, fill, stroke=None, sw=1.0, r=0.0, ellipse=False, clip=False) -> str:
    border = f"border:{sw}px solid {stroke};" if stroke and sw > 0 else ""
    radius = "border-radius:50%;" if ellipse else (f"border-radius:{r}px;" if r else "")
    css = (
        f"position:absolute;left:{x:.1f}px;top:{y:.1f}px;width:{w:.1f}px;height:{h:.1f}px;"
        f"box-sizing:border-box;background:{fill or 'transparent'};{border}{radius}"
        + ("overflow:hidden;" if clip else "")
    )
    return f"<div {_style(css)}></div>"


def _line(x1, y1, x2, y2, stroke, sw=1.0) -> str:
    left, top = min(x1, x2), min(y1, y2)
    w, h = max(1.0, abs(x2 - x1)), max(1.0, abs(y2 - y1))
    css = f"position:absolute;left:{left:.1f}px;top:{top:.1f}px;overflow:visible"
    return (
        f'<svg {_style(css)} width="{w:.1f}" height="{h:.1f}"><line x1="{x1 - left:.1f}" '
        f'y1="{y1 - top:.1f}" x2="{x2 - left:.1f}" y2="{y2 - top:.1f}" '
        f'stroke="{html_lib.escape(stroke, quote=True)}" stroke-width="{sw}"/></svg>'
    )


def _text(x, y, w, h, text, P, *, size=16.0, weight=400, color=None, align="left",
          valign="top", font=None, lh=1.35, pad=0.0, upper=False) -> str:
    justify = {"center": "center", "bottom": "flex-end"}.get(valign, "flex-start")
    words = html_lib.escape(str(text or "")).replace("\n", "<br>")
    css = (
        f"position:absolute;left:{x:.1f}px;top:{y:.1f}px;width:{w:.1f}px;height:{h:.1f}px;"
        f"box-sizing:border-box;padding:0 {pad:g}px;display:flex;flex-direction:column;"
        f"justify-content:{justify};overflow:hidden;font:{weight:g} {size:g}px/{lh} "
        f"{font or P['body']};color:{color or P['text']};text-align:{align};"
        + ("text-transform:uppercase;" if upper else "")
        + "overflow-wrap:anywhere"
    )
    return f"<div {_style(css)}><div>{words}</div></div>"


def _image(x, y, w, h, src: str | None, P, r=0.0, fit="cover") -> str:
    if not src:
        return (_box(x, y, w, h, P["surface"], P["line"], 1, r)
                + _line(x, y, x + w, y + h, P["line"]) + _line(x + w, y, x, y + h, P["line"]))
    css = (
        f"position:absolute;left:{x:.1f}px;top:{y:.1f}px;width:{w:.1f}px;height:{h:.1f}px;"
        f"object-fit:{fit};border-radius:{r}px"
    )
    return f'<img src="{html_lib.escape(src, quote=True)}" {_style(css)}>'


def layer_html(layer: dict, P: dict, pictures: dict[str, str]) -> str:
    """One layer, in its own coordinates -- the same shapes as the client's
    `expand` in lib/wireframe.js."""
    w, h = max(1.0, _n(layer.get("w"), 1)), max(1.0, _n(layer.get("h"), 1))
    r = _n(layer.get("radius"), None) if layer.get("radius") is not None else None
    stroke_off = layer.get("stroke") == "none"
    fill = lambda fb: _c(layer.get("fill"), fb)  # noqa: E731
    stroke = lambda fb: None if stroke_off else _c(layer.get("stroke"), fb)  # noqa: E731
    sw = max(0.0, _n(layer.get("strokeWidth"), 1.0))
    text = layer.get("text") or ""
    kind = layer.get("type")
    picture = pictures.get(layer.get("image") or "")

    if kind == "ellipse":
        return _box(0, 0, w, h, fill(P["surface"]), stroke(P["line"]), sw, ellipse=True)
    if kind == "line":
        return _line(0, 0, w, 0 if h <= 2 else h, _c(layer.get("stroke"), P["strong"]), max(1.0, sw))
    if kind == "text":
        heading = layer.get("font") == "heading"
        font = P["head"] if heading else (P["mono"] if layer.get("font") == "mono" else P["body"])
        return _text(0, 0, w, h, text, P, size=_n(layer.get("size"), 16),
                     weight=_n(layer.get("weight"), P["headWeight"] if heading else 400),
                     color=_c(layer.get("color"), P["text"]), align=layer.get("align") or "left",
                     font=font, upper=heading and P["headCase"] == "uppercase")
    if kind == "image":
        return _image(0, 0, w, h, picture, P, r or 0, "contain" if layer.get("fit") == "contain" else "cover")
    if kind == "button":
        variant = layer.get("variant") or "primary"
        primary = variant == "primary"
        bg = fill(P["accent"]) if primary else ("transparent" if variant == "ghost" else fill(P["bg"]))
        edge = stroke(P["strong"]) if variant == "secondary" else None
        return (_box(0, 0, w, h, bg, edge, sw, r if r is not None else P["radius"])
                + _text(0, 0, w, h, text or "Button", P, size=_n(layer.get("size"), 15), weight=600,
                        align="center", valign="center", pad=12,
                        color=_c(layer.get("color"), P["onAccent"] if primary else P["text"])))
    if kind == "input":
        return (_box(0, 0, w, h, fill(P["bg"]), stroke(P["line"]), sw, r if r is not None else P["radius"])
                + _text(0, 0, w, h, text or "Placeholder", P, size=_n(layer.get("size"), 15),
                        color=_c(layer.get("color"), P["muted"]), valign="center", pad=14))
    if kind == "checkbox":
        on = bool(layer.get("checked"))
        s = min(20.0, h)
        y = (h - s) / 2
        mark = _text(0, y, s, s, "✓", P, size=13, weight=700, color=P["onAccent"], align="center",
                     valign="center", lh=1) if on else ""
        return (_box(0, y, s, s, P["accent"] if on else P["bg"], None if on else P["strong"], 1.5, 4)
                + mark + _text(s + 10, 0, max(1.0, w - s - 10), h, text, P,
                               size=_n(layer.get("size"), 15), valign="center"))
    if kind == "toggle":
        on = bool(layer.get("checked"))
        th = min(24.0, h)
        tw = th * 1.7
        y = (h - th) / 2
        knob = th - 6
        return (_box(0, y, tw, th, P["accent"] if on else P["line"], None, 0, th / 2)
                + _box(tw - knob - 3 if on else 3, y + 3, knob, knob, "#FFFFFF", ellipse=True)
                + _text(tw + 12, 0, max(1.0, w - tw - 12), h, text, P,
                        size=_n(layer.get("size"), 15), valign="center"))
    if kind == "avatar":
        if picture:
            return _image(0, 0, w, h, picture, P, min(w, h) / 2)
        return (_box(0, 0, w, h, fill(P["surface"]), stroke(P["line"]), sw, ellipse=True)
                + _text(0, 0, w, h, text[:2].upper(), P, size=max(9.0, min(w, h) * 0.36),
                        weight=600, color=P["muted"], align="center", valign="center", lh=1))
    if kind == "icon":
        return _text(0, 0, w, h, ICONS.get(layer.get("icon") or "", "◇"), P, size=min(w, h) * 0.8,
                     color=_c(layer.get("color"), P["strong"]), align="center", valign="center", lh=1)
    if kind == "nav":
        items = [str(i) for i in (layer.get("items") or [])][:6]
        pad = min(24.0, w * 0.05)
        logo = min(28.0, h - 16)
        out = (_box(0, 0, w, h, fill(P["bg"]))
               + _line(0, h - 0.5, w, h - 0.5, P["line"])
               + _box(pad, (h - logo) / 2, logo, logo, P["accent"], r=6)
               + _text(pad + logo + 10, 0, max(1.0, w * 0.4), h, text or "Brand", P, size=17,
                       weight=700, valign="center", font=P["head"]))
        right = w - pad
        for item in reversed(items):
            iw = len(item) * 15 * 0.56 + 6
            right -= iw
            out += _text(right, 0, iw, h, item, P, size=15, color=P["muted"], valign="center", align="right")
            right -= 20
        return out
    if kind == "card":
        media = (_image(0, 0, w, h * 0.5, picture, P) if picture else
                 _box(0, 0, w, h * 0.5, P["surface"]) + _line(0, 0, w, h * 0.5, P["line"])
                 + _line(w, 0, 0, h * 0.5, P["line"]))
        top = h * 0.5 + 16
        css = (
            f"position:absolute;left:0;top:0;width:{w:.1f}px;height:{h:.1f}px;overflow:hidden;"
            f"border-radius:{r if r is not None else P['radius'] * 1.5}px;box-sizing:border-box;"
            f"border:{sw}px solid {stroke(P['line']) or 'transparent'};background:{fill(P['bg'])}"
        )
        return (
            f"<div {_style(css)}>{media}"
            + _text(16, top, max(1.0, w - 32), 24, text or "Card title", P, size=17, weight=600, font=P["head"])
            + _box(16, top + 34, (w - 32) * 0.92, 8, P["line"], r=4)
            + _box(16, top + 52, (w - 32) * 0.64, 8, P["line"], r=4)
            + "</div>"
        )
    if kind == "lines":
        count = max(1, min(12, round(_n(layer.get("count"), 3))))
        widths = (1, 0.94, 0.98, 0.88, 0.96, 0.9)
        return "".join(
            _box(0, i * 18, w * (0.62 if i == count - 1 and count > 1 else widths[i % len(widths)]),
                 8, _c(layer.get("fill"), P["line"]), r=4)
            for i in range(count)
        )
    return _box(0, 0, w, h, fill(P["surface"]), stroke(P["line"]), sw, r or 0)


def frame_html(frame: dict, P: dict, pictures: dict[str, str]) -> str:
    def place(layer: dict) -> str:
        css = (
            f"position:absolute;left:{_n(layer.get('x')):.1f}px;top:{_n(layer.get('y')):.1f}px;"
            f"width:{_n(layer.get('w'), 1):.1f}px;height:{_n(layer.get('h'), 1):.1f}px;"
            f"opacity:{max(0.0, min(1.0, _n(layer.get('opacity'), 1.0)))}"
        )
        return f"<div {_style(css)}>{layer_html(layer, P, pictures)}</div>"

    inner = "".join(place(l) for l in frame.get("layers", []) if not l.get("hidden"))
    css = (
        f"position:relative;width:{_n(frame.get('w'), 393):.0f}px;"
        f"height:{_n(frame.get('h'), 852):.0f}px;overflow:hidden;"
        f"background:{_c(frame.get('fill'), P['bg'])};box-shadow:0 1px 3px rgba(15,23,42,.18)"
    )
    return f"<div {_style(css)}>{inner}</div>"


def wireframe_stage(doc: dict, frames: list[dict], pictures: dict[str, str] | None = None) -> str:
    """Frames side by side on the board, each under its name, scaled to fit."""
    P = palette(doc)
    pictures = pictures or {}
    gap, label = 60, 28
    total_w = sum(_n(f.get("w"), 393) for f in frames) + gap * max(0, len(frames) - 1)
    total_h = max((_n(f.get("h"), 852) for f in frames), default=0) + label
    scale = min((STAGE - 48) / max(1.0, total_w), (STAGE - 48) / max(1.0, total_h))
    left = (STAGE - total_w * scale) / 2
    x = 0.0
    parts = []
    for frame in frames:
        parts.append(
            f"<div {_style(f'position:absolute;left:{x:.1f}px;top:0')}>"
            f"<div {_style(f'{_LABEL};height:{label}px')}>{html_lib.escape(frame.get('id', ''))} · "
            f"{html_lib.escape(frame.get('name', ''))}</div>{frame_html(frame, P, pictures)}</div>"
        )
        x += _n(frame.get("w"), 393) + gap
    box = _style(
        f"position:absolute;left:{left:.1f}px;top:24px;width:{total_w:.0f}px;"
        f"height:{total_h:.0f}px;transform:scale({scale:.4f});transform-origin:0 0"
    )
    return _stage(f"<div {box}>" + "".join(parts) + "</div>")


def data_uri(mime: str, data: bytes) -> str:
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"
