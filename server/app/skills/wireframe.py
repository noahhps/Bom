"""Wireframes: screens made of frames and layers, drawn by the canvas panel.

A wireframe is the Figma-shaped document: a board of **frames** (a phone
screen, a desktop page, a slide) each holding **layers** -- rectangles, text,
images, and a small kit of UI components (buttons, inputs, nav bars, cards,
toggles, placeholder text lines). The panel draws it with HTML and CSS, lets
the reader select, move, resize and restyle every layer, click through it as a
prototype, and export it as a deck, HTML + CSS, a PDF or PNGs.

The model writes it through `write_wireframe`, and does not have to do
geometry to do so. A layer with no position is placed by a **flow** pass:
stacked top to bottom inside the frame's padding, full width where that is
what the component wants, with sensible default heights -- so "a login screen
with a logo, two inputs and a button" is five layers with no numbers in them
and still comes out aligned. A `row` layer lays its children side by side.
Explicit x/y/w/h always wins, for the model that wants a precise layout.

Coordinates are stored absolute (relative to the frame), after the flow pass,
so the editor never has to know a layout ran.
"""

from __future__ import annotations

import json
import math
import re

from ..design_presets import clean_theme
from ..store import Store
from .args import as_dict, plain_text
from .skill import Skill
from .slides import save_canvas

KIND = "wireframe"

LAYER_TYPES = (
    "rect", "ellipse", "line", "text", "image", "button", "input", "checkbox",
    "toggle", "avatar", "icon", "nav", "card", "lines",
)

#: What models call the layer types when they do not use these names.
_TYPE_ALIASES = {
    "box": "rect", "rectangle": "rect", "container": "rect", "panel": "rect",
    "section": "rect", "shape": "rect", "circle": "ellipse", "oval": "ellipse",
    "divider": "line", "separator": "line", "hr": "line", "rule": "line",
    "heading": "text", "title": "text", "label": "text", "paragraph": "text",
    "caption": "text", "h1": "text", "h2": "text", "h3": "text", "p": "text",
    "img": "image", "photo": "image", "picture": "image", "hero": "image",
    "placeholder": "image", "illustration": "image", "cta": "button", "link": "button",
    "textbox": "input", "textfield": "input", "field": "input", "search": "input",
    "select": "input", "dropdown": "input", "textarea": "input",
    "switch": "toggle", "radio": "checkbox", "navbar": "nav", "header": "nav",
    "topbar": "nav", "appbar": "nav", "tile": "card", "listitem": "card",
    "text_lines": "lines", "body_text": "lines", "copy": "lines", "profile": "avatar",
}

#: Screen sizes, by name. Figma's own frame presets, near enough.
FRAME_PRESETS = {
    "iphone": (393, 852), "phone": (393, 852), "mobile": (393, 852),
    "android": (360, 800), "tablet": (834, 1194), "ipad": (834, 1194),
    "desktop": (1440, 1024), "laptop": (1280, 832), "web": (1440, 1024),
    "slide": (1280, 720), "presentation": (1280, 720),
}

MAX_FRAMES = 24
MAX_LAYERS = 250
FRAME_GAP = 120

_COLOUR = re.compile(
    r"^(#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\([0-9.,%\s/+-]{3,60}\)|[a-zA-Z]{3,24})$"
)
_IMAGE_ID = re.compile(r"img_[A-Za-z0-9]+")

#: Components that fill the width of the frame when the flow places them.
_FULL_WIDTH = {"nav", "input", "card", "lines", "line", "image", "rect", "text", "button"}


def _num(value, default=None, lo=-100_000.0, hi=100_000.0):
    try:
        number = float(plain_text(value) if not isinstance(value, (int, float)) else value)
    except (TypeError, ValueError):
        return default
    if math.isnan(number) or math.isinf(number):
        return default
    return round(max(lo, min(hi, number)), 2)


def _colour(value) -> str | None:
    text = plain_text(value)
    return text if text and _COLOUR.match(text) else None


def _layer_type(raw: dict) -> str:
    named = plain_text(raw.get("type") or raw.get("kind") or raw.get("component")).lower()
    named = named.replace("-", "_").replace(" ", "_")
    named = _TYPE_ALIASES.get(named, named)
    if named in LAYER_TYPES or named == "row":
        return named
    if raw.get("children"):
        return "row"
    if raw.get("placeholder"):
        return "input"
    if raw.get("text") or raw.get("content"):
        return "text"
    return "rect"


def _default_size(kind: str, layer: dict, avail: float) -> tuple[float, float]:
    """Width and height a component takes when the model gave none."""
    size = layer.get("size") or (28 if layer.get("heading") else 16)
    if kind == "text":
        text = layer.get("text", "")
        width = avail
        per_line = max(1, int(width / (size * 0.55)))
        lines = sum(max(1, math.ceil(len(part) / per_line)) for part in (text.split("\n") or [""]))
        return width, round(lines * size * 1.35 + 2)
    return {
        # Full width on a phone, where a button usually is; a sensible width
        # on anything larger, where a full-width one looks like a banner.
        "button": (avail if avail < 500 else min(avail, 220.0), 48.0),
        "input": (avail, 48.0),
        "checkbox": (avail, 28.0),
        "toggle": (avail, 28.0),
        "avatar": (48.0, 48.0),
        "icon": (24.0, 24.0),
        "nav": (avail, 64.0),
        "card": (avail, 220.0),
        "lines": (avail, float(max(1, int(layer.get("count") or 3)) * 18 - 10)),
        "image": (avail, round(avail * 0.56)),
        "rect": (avail, 120.0),
        "ellipse": (80.0, 80.0),
        "line": (avail, 1.0),
    }.get(kind, (avail, 80.0))


def _layer(raw, index: int, frame_id: str, avail: float) -> dict | None:
    """One layer, cleaned. Position may still be missing -- the flow sets it."""
    raw = as_dict(raw) if not isinstance(raw, dict) else raw
    if not isinstance(raw, dict):
        return None
    kind = _layer_type(raw)
    layer: dict = {"id": f"{frame_id}_l{index}", "type": kind}
    name = plain_text(raw.get("name"))
    if name:
        layer["name"] = name[:80]
    text = plain_text(raw.get("text") or raw.get("label") if kind != "input" else
                      raw.get("placeholder") or raw.get("text") or raw.get("label"))
    if not text and kind == "text":
        text = plain_text(raw.get("content") or raw.get("title"))
    if text:
        layer["text"] = text[:2000]
    for key in ("x", "y", "w", "h"):
        alias = {"w": ("w", "width"), "h": ("h", "height"), "x": ("x", "left"), "y": ("y", "top")}[key]
        value = next((raw[a] for a in alias if a in raw), None)
        number = _num(value, None, -10_000, 10_000)
        if number is not None:
            layer[key] = number if key in ("x", "y") else max(1.0, number)
    for key in ("fill", "stroke", "color"):
        colour = _colour(raw.get(key) or raw.get({"fill": "background", "color": "textColor"}.get(key, "")))
        if colour:
            layer[key] = colour
    for key, lo, hi in (("radius", 0, 999), ("strokeWidth", 0, 40), ("opacity", 0, 1),
                        ("size", 6, 200), ("count", 1, 12)):
        number = _num(raw.get(key) or raw.get({"size": "fontSize", "radius": "cornerRadius"}.get(key, "")), None, lo, hi)
        if number is not None:
            layer[key] = number
    weight = _num(raw.get("weight") or raw.get("fontWeight"), None, 100, 900)
    if weight is not None:
        layer["weight"] = int(round(weight / 100) * 100)
    heading = plain_text(raw.get("type")).lower() in ("heading", "title", "h1", "h2", "h3")
    if heading:
        layer["font"] = "heading"
        layer.setdefault("size", {"h1": 36, "h2": 28, "h3": 22}.get(plain_text(raw.get("type")).lower(), 28))
        layer.setdefault("weight", 700)
    font = plain_text(raw.get("font")).lower()
    if font in ("heading", "body", "mono"):
        layer["font"] = font
    align = plain_text(raw.get("align") or raw.get("textAlign")).lower()
    if align in ("left", "center", "right"):
        layer["align"] = align
    variant = plain_text(raw.get("variant") or raw.get("style")).lower()
    if variant in ("primary", "secondary", "ghost"):
        layer["variant"] = variant
    if raw.get("checked") in (True, "true", 1, "on"):
        layer["checked"] = True
    items = raw.get("items") or raw.get("links")
    if items is not None and kind == "nav":
        listed = items if isinstance(items, list) else plain_text(items).replace("\n", ",").split(",")
        layer["items"] = [plain_text(i)[:30] for i in listed if plain_text(i)][:6]
    icon = plain_text(raw.get("icon") or (raw.get("name") if kind == "icon" else ""))
    if icon and kind == "icon":
        layer["icon"] = icon.lower()[:20]
    image = raw.get("image") or raw.get("src") or raw.get("imageId")
    hit = _IMAGE_ID.search(plain_text(image)) if image else None
    if hit and kind in ("image", "card", "avatar", "rect"):
        layer["image"] = hit.group(0)
    link = plain_text(raw.get("link") or raw.get("onClick") or raw.get("navigate") or raw.get("goto"))
    if link:
        layer["link"] = link[:80]
    if raw.get("hidden") in (True, "true"):
        layer["hidden"] = True
    if kind == "row":
        layer["children"] = [c for c in (raw.get("children") or []) if c]
        layer["gap"] = _num(raw.get("gap"), 12, 0, 200)
    return layer


def _flow(frame: dict, layers: list[dict], padding: float, gap: float) -> list[dict]:
    """Place every layer that has no position, top to bottom, and flatten rows."""
    out: list[dict] = []
    y = padding
    avail = frame["w"] - 2 * padding
    for layer in layers:
        if layer["type"] == "row":
            children = layer.pop("children", [])
            row_gap = layer.get("gap", 12)
            count = max(1, len(children))
            each = (avail - row_gap * (count - 1)) / count
            placed = []
            for n, raw in enumerate(children):
                child = _layer(raw, 0, "tmp", each)
                if child is None or child["type"] == "row":
                    continue
                w, h = _default_size(child["type"], child, each)
                child.setdefault("w", round(each if child["type"] not in ("avatar", "icon", "ellipse") else w, 2))
                child.setdefault("h", h)
                child.setdefault("x", round(padding + n * (each + row_gap), 2))
                child.setdefault("y", round(layer.get("y", y), 2))
                placed.append(child)
            if placed:
                out.extend(placed)
                y = max(c["y"] + c["h"] for c in placed) + gap
            continue
        w, h = _default_size(layer["type"], layer, avail)
        layer.setdefault("w", w)
        layer.setdefault("h", h)
        if "x" not in layer:
            layer["x"] = padding if layer["type"] != "nav" else 0
            if layer["type"] == "nav":
                layer["w"] = frame["w"]
        if "y" not in layer:
            layer["y"] = 0 if layer["type"] == "nav" and y == padding else round(y, 2)
            y = layer["y"] + layer["h"] + gap
        else:
            y = max(y, layer["y"] + layer["h"] + gap)
        out.append(layer)
    return out


def normalize_wireframe(frames, fidelity=None, theme=None, defaults: dict | None = None) -> dict:
    """The stored document: fidelity, theme, and frames of absolute layers."""
    listed = frames if isinstance(frames, list) else []
    if isinstance(frames, str):
        parsed = as_dict(frames)
        listed = parsed.get("frames", []) if parsed else []
        if not listed:
            try:
                value = json.loads(frames)
                listed = value if isinstance(value, list) else []
            except ValueError:
                listed = []
    out_frames: list[dict] = []
    cursor = 0.0
    for index, raw in enumerate(listed[:MAX_FRAMES]):
        raw = as_dict(raw) if not isinstance(raw, dict) else raw
        if not isinstance(raw, dict):
            continue
        frame_id = f"f{index + 1}"
        preset = plain_text(raw.get("preset") or raw.get("device")).lower()
        pw, ph = FRAME_PRESETS.get(preset, FRAME_PRESETS["iphone"])
        w = _num(raw.get("w") or raw.get("width"), pw, 100, 4000)
        h = _num(raw.get("h") or raw.get("height"), ph, 100, 8000)
        frame = {
            "id": frame_id,
            "name": (plain_text(raw.get("name") or raw.get("title")) or f"Frame {index + 1}")[:80],
            "x": _num(raw.get("x"), cursor, -100_000, 100_000),
            "y": _num(raw.get("y"), 0, -100_000, 100_000),
            "w": w,
            "h": h,
        }
        fill = _colour(raw.get("fill") or raw.get("background"))
        if fill:
            frame["fill"] = fill
        cursor = frame["x"] + w + FRAME_GAP
        padding = _num(raw.get("padding"), 24 if w < 700 else 64, 0, 400)
        gap = _num(raw.get("gap"), 16, 0, 400)
        avail = w - 2 * padding
        layers = [
            layer for layer in (
                _layer(item, n, frame_id, avail)
                for n, item in enumerate((raw.get("layers") or raw.get("children") or [])[:MAX_LAYERS])
            ) if layer
        ]
        frame["layers"] = _flow(frame, layers, padding, gap)
        for n, layer in enumerate(frame["layers"]):
            layer["id"] = f"{frame_id}_l{n + 1}"
        out_frames.append(frame)

    # Links name a frame by its name or id; resolve to ids, drop the rest.
    by_name = {f["name"].lower(): f["id"] for f in out_frames}
    ids = {f["id"] for f in out_frames}
    for frame in out_frames:
        for layer in frame["layers"]:
            target = layer.get("link")
            if target is None:
                continue
            resolved = target if target in ids else by_name.get(target.lower())
            if resolved and resolved != frame["id"]:
                layer["link"] = resolved
            else:
                layer.pop("link", None)

    mode = plain_text(fidelity).lower()
    doc = {
        "version": 1,
        "fidelity": "styled" if mode in ("styled", "hifi", "high", "high-fidelity", "mockup") else "wireframe",
        "theme": {**clean_theme(defaults or {}), **clean_theme(theme)},
        "frames": out_frames,
    }
    return doc


def outline(doc: dict) -> str:
    """A wireframe as a model reads it back: frames, then layers with boxes."""
    lines = [f"fidelity: {doc.get('fidelity', 'wireframe')}"]
    for frame in doc.get("frames", []):
        lines.append(f"frame {frame['id']} \"{frame['name']}\" {int(frame['w'])}×{int(frame['h'])}")
        for layer in frame.get("layers", []):
            box = f"{int(layer.get('x', 0))},{int(layer.get('y', 0))} {int(layer.get('w', 0))}×{int(layer.get('h', 0))}"
            words = f" \"{layer['text'][:60]}\"" if layer.get("text") else ""
            extra = f" → {layer['link']}" if layer.get("link") else ""
            lines.append(f"  - {layer['type']} {box}{words}{extra}")
    return "\n".join(lines)


def to_slides(doc: dict) -> dict:
    """A deck with one board slide per frame, drawn from the same layers."""
    return {
        "version": 1,
        "theme": doc.get("theme", {}),
        "slides": [
            {
                "layout": "board",
                "title": frame["name"],
                "board": {"fidelity": doc.get("fidelity", "wireframe"), "frame": frame},
            }
            for frame in doc.get("frames", [])
        ],
    }


LAYER_SCHEMA = {
    "type": "object",
    "properties": {
        "type": {"type": "string", "enum": list(LAYER_TYPES) + ["row"]},
        "text": {"type": "string"},
        "x": {"type": "number"}, "y": {"type": "number"},
        "w": {"type": "number"}, "h": {"type": "number"},
        "fill": {"type": "string"}, "stroke": {"type": "string"}, "color": {"type": "string"},
        "radius": {"type": "number"}, "size": {"type": "number"}, "weight": {"type": "number"},
        "align": {"type": "string", "enum": ["left", "center", "right"]},
        "variant": {"type": "string", "enum": ["primary", "secondary", "ghost"]},
        "items": {"type": "array", "items": {"type": "string"}},
        "image": {"type": "string"},
        "icon": {"type": "string"},
        "count": {"type": "number"},
        "checked": {"type": "boolean"},
        "link": {"type": "string", "description": "Name of the frame a click goes to."},
        "children": {"type": "array", "items": {"type": "object"}},
    },
}


class WriteWireframe(Skill):
    surfaces = "canvas"
    wants_session = True
    themed = True

    def __init__(self, store: Store) -> None:
        super().__init__(
            name="write_wireframe",
            description=(
                "Create or replace a wireframe -- screens for an app or a site, "
                "shown in the canvas panel as Figma-style frames the user can "
                "edit, click through as a prototype, and export as slides, HTML "
                "+ CSS, PDF or PNG. Use it whenever the user wants to lay out a "
                "screen, a flow, a page structure or a UI mockup. "
                "Each frame is a screen: {name, preset ('iphone', 'android', "
                "'tablet', 'desktop', 'laptop', 'slide') or w/h, layers[]}. "
                "Layers are drawn in order, later on top. Types: text (with size, "
                "weight; use a heading type -- 'h1', 'h2', 'heading' -- for "
                "titles), button {text, variant primary|secondary|ghost}, input "
                "{text as the placeholder}, checkbox and toggle {text, checked}, "
                "nav {text as the brand, items[]}, card {text}, image {image: an "
                "id from list_images, or none for a placeholder}, lines {count -- "
                "placeholder body text}, avatar, icon {icon: menu, search, "
                "heart, star, user, bell, cart, home, settings, close, plus, "
                "arrow}, rect, ellipse, line, and row {children[]} to put layers "
                "side by side. Leave out x/y/w/h and layers stack top to bottom "
                "with even spacing -- usually what you want; give them for exact "
                "placement (relative to the frame). Put `link` on a button or "
                "card with another frame's name to make the prototype navigate. "
                "fidelity 'wireframe' (default) is greyscale boxes; 'styled' uses "
                "the design standard -- call ask_for_design first for that. "
                "Reusing a title replaces the wireframe."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "The wireframe's name."},
                    "frames": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string"},
                                "preset": {"type": "string"},
                                "w": {"type": "number"},
                                "h": {"type": "number"},
                                "fill": {"type": "string"},
                                "layers": {"type": "array", "items": LAYER_SCHEMA},
                            },
                        },
                    },
                    "fidelity": {"type": "string", "enum": ["wireframe", "styled"]},
                },
                "required": ["frames"],
            },
        )
        self.store = store

    def wants_design(self, arguments: dict) -> bool:
        """Only a styled mockup has a look to ask about; a wireframe is grey."""
        return plain_text(arguments.get("fidelity")).lower() in ("styled", "hifi", "mockup")

    async def use(self, session: str, title=None, frames=None, fidelity=None, theme=None,
                  design_defaults: dict | None = None, theme_override: dict | None = None,
                  **extra) -> str:
        if frames is None:
            frames = next((extra[k] for k in ("screens", "pages", "artboards") if k in extra), None)
        doc = normalize_wireframe(frames, fidelity, {**(theme_override or {})} or theme, design_defaults)
        if not doc["frames"]:
            return "That wireframe had no frames. Pass `frames` as a list of screens, each with layers."
        from .images import known_ids

        known = known_ids(self.store, session)
        dropped = []
        for frame in doc["frames"]:
            for layer in frame["layers"]:
                if layer.get("image") and layer["image"] not in known:
                    dropped.append(layer.pop("image"))
        name = (plain_text(title or extra.get("name")) or doc["frames"][0]["name"] or "Wireframe")[:200]
        verb = save_canvas(self.store, session, name, json.dumps(doc, ensure_ascii=False), KIND)
        count = len(doc["frames"])
        layers = sum(len(f["layers"]) for f in doc["frames"])
        links = sum(1 for f in doc["frames"] for l in f["layers"] if l.get("link"))
        said = (
            f"{verb} the wireframe {name!r}: {count} frame{'' if count == 1 else 's'}, "
            f"{layers} layers" + (f", {links} prototype links" if links else "") + ". It is "
            "open in the canvas panel, where the user can edit it, click through it and "
            "export it. Revise it with write_wireframe and the same title (read_canvas "
            "shows every layer's position), or turn it into a deck with wireframe_to_slides."
        )
        if dropped:
            said += f" Left off images that do not exist: {', '.join(dropped)} -- call list_images."
        return said


class WireframeToSlides(Skill):
    surfaces = "canvas"
    wants_session = True

    def __init__(self, store: Store) -> None:
        super().__init__(
            name="wireframe_to_slides",
            description=(
                "Turn a wireframe into a slide deck: one slide per frame, each "
                "showing the screen, titled with the frame's name. For presenting "
                "a flow or a design review. The deck opens in the canvas panel."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "The wireframe to convert."},
                    "deck_title": {"type": "string", "description": "Name for the new deck."},
                },
                "required": ["title"],
            },
        )
        self.store = store

    async def use(self, session: str, title=None, deck_title=None, **extra) -> str:
        name = plain_text(title)
        canvas = self.store.find_canvas_by_title(session, name) if name else None
        if canvas is None or canvas.kind != KIND:
            found = [c.title for c in self.store.session_canvases(session) if c.kind == KIND]
            if len(found) == 1 and not name:
                canvas = self.store.find_canvas_by_title(session, found[0])
            else:
                listed = ", ".join(repr(t) for t in found) or "none"
                return f"There is no wireframe called {name!r}. Wireframes here: {listed}."
        try:
            doc = json.loads(canvas.content or "{}")
        except ValueError:
            return f"{canvas.title!r} could not be read as a wireframe."
        deck = to_slides(doc)
        if not deck["slides"]:
            return f"{canvas.title!r} has no frames to turn into slides."
        deck_name = (plain_text(deck_title) or f"{canvas.title} — deck")[:200]
        verb = save_canvas(self.store, session, deck_name, json.dumps(deck, ensure_ascii=False, indent=1), "slides")
        return (
            f"{verb} the deck {deck_name!r} with {len(deck['slides'])} slides, one per frame "
            f"of {canvas.title!r}. It is open in the canvas panel."
        )
