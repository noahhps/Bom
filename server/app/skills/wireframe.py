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
        # 0.62em a character: wireframes are set in Bom's monospace, which is
        # wider than a proportional face and would otherwise be clipped.
        per_line = max(1, int(width / (size * 0.62)))
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


def _flow(frame: dict, layers: list[dict], padding: float, gap: float,
          start: float | None = None) -> list[dict]:
    """Place every layer that has no position, top to bottom, and flatten rows.

    `start` is where the first unplaced layer goes -- the top padding for a
    new frame, or below an existing layer when an edit inserts into one.
    """
    out: list[dict] = []
    y = padding if start is None else start
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
            layer["y"] = 0 if layer["type"] == "nav" and y == padding and start is None else round(y, 2)
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


#: Layer properties worth showing when reading a wireframe back, in order.
_SHOWN = ("variant", "size", "weight", "font", "align", "fill", "stroke", "color",
          "radius", "icon", "image", "count", "checked", "opacity", "hidden")


def _shown(value) -> str:
    """A property as the outline prints it: 36, not 36.0."""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def outline(doc: dict) -> str:
    """A wireframe as a model reads it back: frames, then layers with ids and
    boxes -- the ids are what edit_wireframe addresses."""
    lines = [f"fidelity: {doc.get('fidelity', 'wireframe')}"]
    if doc.get("theme"):
        lines.append(f"theme: {json.dumps(doc['theme'])}")
    for frame in doc.get("frames", []):
        fill = f" fill {frame['fill']}" if frame.get("fill") else ""
        lines.append(f"frame {frame['id']} \"{frame['name']}\" {int(frame['w'])}×{int(frame['h'])}{fill}")
        for layer in frame.get("layers", []):
            box = f"{int(layer.get('x', 0))},{int(layer.get('y', 0))} {int(layer.get('w', 0))}×{int(layer.get('h', 0))}"
            words = f" \"{layer['text'][:80]}\"" if layer.get("text") else ""
            props = "".join(
                f" {key}={_shown(layer[key])}" for key in _SHOWN
                if layer.get(key) not in (None, "", False)
            )
            if layer.get("items"):
                props += f" items={','.join(layer['items'])}"
            extra = f" → {layer['link']}" if layer.get("link") else ""
            lines.append(f"  - {layer.get('id', '?')} {layer['type']} {box}{words}{props}{extra}")
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
            "export it. Change it with edit_wireframe (read_canvas shows every layer's "
            "id and position), or turn it into a deck with wireframe_to_slides."
        )
        if dropped:
            said += f" Left off images that do not exist: {', '.join(dropped)} -- call list_images."
        from ..design_check import check_wireframe, summary

        said += summary(check_wireframe(doc))
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


# -- editing in place ------------------------------------------------------------

#: What each operation is called by the models that do not use our word.
_OP_ALIASES = {
    "set": "update", "edit": "update", "change": "update", "modify": "update",
    "style": "update", "restyle": "update", "resize": "update",
    "insert": "add", "create": "add", "add_layer": "add", "append": "add",
    "delete": "remove", "remove_layer": "remove", "delete_layer": "remove",
    "reorder": "order", "arrange": "order", "bring_to_front": "order",
    "send_to_back": "order", "z": "order",
    "new_frame": "add_frame", "add_screen": "add_frame", "new_screen": "add_frame",
    "edit_frame": "update_frame", "set_frame": "update_frame", "rename_frame": "update_frame",
    "update_screen": "update_frame",
    "delete_frame": "remove_frame", "remove_screen": "remove_frame", "delete_screen": "remove_frame",
    "copy_frame": "duplicate_frame", "duplicate_screen": "duplicate_frame", "clone_frame": "duplicate_frame",
    "set_theme": "theme", "set_fidelity": "fidelity",
    "align_layers": "align", "distribute_layers": "distribute", "space": "distribute",
    "translate": "move", "nudge": "move",
}

OPS = (
    "update", "add", "remove", "move", "order", "align", "distribute",
    "add_frame", "update_frame", "remove_frame", "duplicate_frame", "theme", "fidelity",
)

#: The keys an op carries that are about the op, not about the layer.
_OP_KEYS = {"op", "action", "type_of_op", "layer", "layers", "id", "ids", "frame", "screen",
            "after", "before", "set", "props", "properties", "changes", "to", "axis",
            "gap", "close_gap", "dx", "dy", "value", "name_new"}


def _padding(frame: dict) -> float:
    return 24.0 if frame["w"] < 700 else 64.0


def _is_backdrop(layer: dict, frame: dict) -> bool:
    """A layer that fills most of the screen -- a background, not a row of the
    stack -- so it neither moves with the flow nor marks where it ends."""
    return layer.get("type") in ("rect", "image", "ellipse") and (
        layer.get("h", 0) >= frame["h"] * 0.8 or layer.get("w", 0) * layer.get("h", 0)
        >= frame["w"] * frame["h"] * 0.6
    )


class _Doc:
    """A wireframe being edited: lookups by frame and layer, and fresh ids."""

    def __init__(self, doc: dict) -> None:
        self.doc = doc
        self.frames: list[dict] = doc.setdefault("frames", [])

    def frame(self, ref) -> dict | None:
        key = plain_text(ref).strip()
        if not key:
            return self.frames[0] if len(self.frames) == 1 else None
        low = key.lower()
        return (
            next((f for f in self.frames if f["id"] == key), None)
            or next((f for f in self.frames if f["name"].lower() == low), None)
            or next((f for f in self.frames if low in f["name"].lower()), None)
        )

    def layer(self, ref, frame_ref=None) -> tuple[dict, dict] | str:
        """(frame, layer) for an id, or for words on the layer; else a reason."""
        key = plain_text(ref).strip()
        if not key:
            return "no layer was named"
        for frame in self.frames:
            for layer in frame["layers"]:
                if layer.get("id") == key:
                    return frame, layer
        # Not an id: the words on it, within one frame if a frame was named.
        scope = [self.frame(frame_ref)] if frame_ref else self.frames
        low = key.lower()
        hits = [
            (f, l) for f in scope if f for l in f["layers"]
            if (l.get("text") or "").strip().lower() == low or (l.get("name") or "").lower() == low
        ] or [
            (f, l) for f in scope if f for l in f["layers"]
            if low in (l.get("text") or "").lower()
        ]
        if len(hits) == 1:
            return hits[0]
        if len(hits) > 1:
            ids = ", ".join(l["id"] for _, l in hits[:5])
            return f"{key!r} matches {len(hits)} layers ({ids}) -- name one by id"
        return f"there is no layer {key!r} -- read_canvas lists every layer's id"

    def next_frame_id(self) -> str:
        taken = {f["id"] for f in self.frames}
        n = len(self.frames) + 1
        while f"f{n}" in taken:
            n += 1
        return f"f{n}"

    @staticmethod
    def next_layer_id(frame: dict) -> str:
        taken = {l.get("id") for l in frame["layers"]}
        numbers = [
            int(m.group(1)) for l in frame["layers"]
            if (m := re.fullmatch(rf"{re.escape(frame['id'])}_l(\d+)", str(l.get("id"))))
        ]
        n = max(numbers, default=0) + 1
        while f"{frame['id']}_l{n}" in taken:
            n += 1
        return f"{frame['id']}_l{n}"


def _layer_ids(item: dict) -> list:
    listed = item.get("layers") if isinstance(item.get("layers"), list) else None
    if listed is None and isinstance(item.get("ids"), list):
        listed = item["ids"]
    if listed is not None:
        return [x for x in listed if not isinstance(x, dict)]
    ref = item.get("layer", item.get("id"))
    return [ref] if ref not in (None, "") and not isinstance(ref, dict) else []


def _changes(item: dict) -> dict:
    """The properties an update sets: under `set`, or loose on the op itself."""
    for key in ("set", "props", "properties", "changes"):
        found = as_dict(item.get(key)) if not isinstance(item.get(key), dict) else item.get(key)
        if isinstance(found, dict):
            return found
    return {k: v for k, v in item.items() if k not in _OP_KEYS}


def _restyle(frame: dict, layer: dict, changes: dict) -> dict | None:
    """`layer` with `changes` applied and cleaned as a new layer would be.

    A value of null removes that property -- how a fill is taken off again.
    """
    merged = {k: v for k, v in layer.items() if k not in ("id",)}
    for key, value in changes.items():
        if value is None:
            merged.pop(key, None)
            # An alias set to nothing clears the property it stands for.
            merged.pop({"width": "w", "height": "h", "background": "fill",
                        "textColor": "color", "fontSize": "size"}.get(key, key), None)
        else:
            merged[key] = value
    # A change of type re-derives what the type implies: a heading's font,
    # size and weight, or plain text losing them.
    if "type" in changes:
        heading = plain_text(changes.get("type")).lower() in ("heading", "title", "h1", "h2", "h3")
        for key in ("size", "weight", "font"):
            if key not in changes and (heading or (key == "font" and merged.get("font") == "heading")):
                merged.pop(key, None)
    cleaned = _layer(merged, 0, frame["id"], frame["w"] - 2 * _padding(frame))
    if cleaned is None:
        return None
    cleaned["id"] = layer["id"]
    for key in ("x", "y", "w", "h"):
        if key not in cleaned and key in layer:
            cleaned[key] = layer[key]
    if cleaned["type"] == "row":
        # A row is a way of placing layers, not a layer; it cannot be made
        # out of an existing one.
        return None
    return cleaned


def _insert(frame: dict, raws: list, anchor: tuple[str, dict] | None) -> tuple[list[dict], str]:
    """Add layers to a frame, flowing any without a position into the stack.

    Below the last layer by default; after or before `anchor` when one is
    named, in which case what was below moves down to make room. A frame the
    new layers run past is made taller, as a scrolling screen would be.
    """
    padding, gap = _padding(frame), 16.0
    avail = frame["w"] - 2 * padding
    stack = [l for l in frame["layers"] if not _is_backdrop(l, frame)]
    if anchor is None:
        start = max((l["y"] + l["h"] for l in stack), default=padding - gap) + gap
    elif anchor[0] == "after":
        start = anchor[1]["y"] + anchor[1]["h"] + gap
    else:
        start = anchor[1]["y"]
    new = [l for l in (_layer(raw, n, frame["id"], avail) for n, raw in enumerate(raws)) if l]
    if not new:
        return [], ""
    flowed = [l for l in new if "y" not in l]
    placed = _flow(frame, new, padding, gap, start=start)
    for n, layer in enumerate(placed):
        layer["id"] = _Doc.next_layer_id({"id": frame["id"], "layers": frame["layers"] + placed[:n]})

    note = ""
    if anchor is not None and flowed:
        bottom = max(l["y"] + l["h"] for l in placed)
        shift = bottom + gap - start
        for layer in frame["layers"]:
            if not _is_backdrop(layer, frame) and layer["y"] >= start - 1 and layer.get("type") != "nav":
                layer["y"] = round(layer["y"] + shift, 2)

    # Order: straight after the anchor, so z-order follows reading order.
    if anchor is not None and anchor[1] in frame["layers"]:
        at = frame["layers"].index(anchor[1]) + (1 if anchor[0] == "after" else 0)
        frame["layers"][at:at] = placed
    else:
        frame["layers"].extend(placed)

    lowest = max((l["y"] + l["h"] for l in frame["layers"] if not _is_backdrop(l, frame)), default=0)
    if lowest + padding > frame["h"] and flowed:
        frame["h"] = round(lowest + padding, 2)
        note = f" ({frame['name']!r} grew to {int(frame['h'])}px tall to fit)"
    return placed, note


def _fit_text(frame: dict, before: dict, after: dict, changes: dict) -> str:
    """Grow a text layer to hold new words, moving what is below it down.

    A text box keeps the height it was given for the words it had; set
    longer words in it and they spill over whatever comes next. Figma's
    auto-height text grows instead, and a stack under it moves with it --
    which is what someone asking for a longer headline expects.
    """
    if after.get("type") != "text" or "h" in changes or "height" in changes:
        return ""
    if not any(k in changes for k in ("text", "content", "size", "fontSize", "type", "w", "width")):
        return ""
    _, needed = _default_size("text", after, after.get("w") or before.get("w") or 100)
    old_bottom = before.get("y", 0) + before.get("h", 0)
    delta = round(needed - after.get("h", 0), 2)
    if delta <= 1:
        return ""
    after["h"] = needed
    left, right = after.get("x", 0), after.get("x", 0) + after.get("w", 0)
    for other in frame["layers"]:
        if other is before or _is_backdrop(other, frame):
            continue
        beside = other.get("x", 0) < right and other.get("x", 0) + other.get("w", 0) > left
        if beside and other.get("y", 0) >= old_bottom - 1:
            other["y"] = round(other["y"] + delta, 2)
    return f", grown {delta:g}px taller to fit"


def _describe(layer: dict) -> str:
    words = f' "{layer["text"][:30]}"' if layer.get("text") else ""
    return f"{layer['id']} ({layer['type']}{words})"


def apply_ops(doc: dict, ops) -> tuple[list[str], list[str]]:
    """Apply `ops` to `doc` in place. Returns (what was done, what was not)."""
    listed = ops
    if isinstance(listed, str):
        parsed = as_dict(listed)
        if parsed is not None:
            listed = parsed.get("ops") if isinstance(parsed.get("ops"), list) else [parsed]
        else:
            try:
                listed = json.loads(listed)
            except ValueError:
                listed = []
    if isinstance(listed, dict):
        listed = [listed]
    if not isinstance(listed, list):
        listed = []

    wf = _Doc(doc)
    done: list[str] = []
    failed: list[str] = []
    for number, raw in enumerate(listed[:60], start=1):
        item = raw if isinstance(raw, dict) else as_dict(raw)
        if not isinstance(item, dict):
            failed.append(f"op {number} is not an object")
            continue
        name = plain_text(item.get("op") or item.get("action")).lower().replace(" ", "_").replace("-", "_")
        name = _OP_ALIASES.get(name, name)
        if name == "order" and plain_text(item.get("op")).lower() in ("bring_to_front", "send_to_back"):
            item = {**item, "to": "front" if "front" in plain_text(item.get("op")).lower() else "back"}
        if not name:
            # No verb: a layer and some properties is an update, a layer spec
            # with a frame is an addition.
            if isinstance(item.get("layer"), dict) or isinstance(item.get("layers"), list) and item.get("frame"):
                name = "add"
            elif item.get("layer") or item.get("id"):
                name = "update"
        where = f"op {number} ({name or '?'})"
        try:
            result = _apply_one(wf, name, item)
        except (KeyError, TypeError, ValueError) as exc:
            result = f"could not be read: {exc}"
        if isinstance(result, list):
            done.extend(result)
        elif result:
            failed.append(f"{where}: {result}")
        # After every op rather than once at the end: a link written by name
        # has to reach its frame before a later op in the same call renames it.
        _resolve_links(wf.frames)
    return done, failed


def _resolve_links(frames: list[dict]) -> None:
    """Links name a frame by id or name; keep the ones that still reach one."""
    ids = {f["id"] for f in frames}
    by_name = {f["name"].lower(): f["id"] for f in frames}
    for frame in frames:
        for layer in frame["layers"]:
            target = layer.get("link")
            if target is None:
                continue
            resolved = target if target in ids else by_name.get(str(target).lower())
            if resolved and resolved != frame["id"]:
                layer["link"] = resolved
            else:
                layer.pop("link", None)


def _apply_one(wf: _Doc, name: str, item: dict):
    """One operation. A list of what it did, or a string saying why not."""
    if name == "update":
        refs = _layer_ids(item)
        if not refs:
            return "name the layer to change by its id"
        changes = _changes(item)
        if not changes:
            return "nothing to set -- put the properties under `set`"
        out = []
        for ref in refs:
            found = wf.layer(ref, item.get("frame"))
            if isinstance(found, str):
                return found
            frame, layer = found
            cleaned = _restyle(frame, layer, changes)
            if cleaned is None:
                return f"{layer['id']} could not take those properties"
            note = _fit_text(frame, layer, cleaned, changes)
            frame["layers"][frame["layers"].index(layer)] = cleaned
            out.append(f"updated {_describe(cleaned)}{note}")
        return out

    if name == "move":
        refs = _layer_ids(item)
        if not refs:
            return "name the layer to move"
        out = []
        for ref in refs:
            found = wf.layer(ref, item.get("frame"))
            if isinstance(found, str):
                return found
            frame, layer = found
            dx = _num(item.get("dx"), 0.0) or 0.0
            dy = _num(item.get("dy"), 0.0) or 0.0
            x = _num(item.get("x"), None)
            y = _num(item.get("y"), None)
            layer["x"] = round((x if x is not None else layer.get("x", 0)) + dx, 2)
            layer["y"] = round((y if y is not None else layer.get("y", 0)) + dy, 2)
            out.append(f"moved {_describe(layer)} to {int(layer['x'])},{int(layer['y'])}")
        return out

    if name == "add":
        frame = wf.frame(item.get("frame") or item.get("screen"))
        anchor = None
        for side in ("after", "before"):
            if item.get(side):
                found = wf.layer(item[side], item.get("frame"))
                if isinstance(found, str):
                    return found
                frame = frame or found[0]
                if found[0] is not frame:
                    return f"{item[side]} is not in {frame['name']!r}"
                anchor = (side, found[1])
                break
        if frame is None:
            names = ", ".join(repr(f["name"]) for f in wf.frames)
            return f"say which frame to add to ({names})"
        spec = item.get("layer") if isinstance(item.get("layer"), (dict, str)) else None
        raws = item.get("layers") if isinstance(item.get("layers"), list) else ([spec] if spec else [])
        if not raws:
            loose = {k: v for k, v in item.items() if k not in _OP_KEYS}
            raws = [loose] if loose else []
        if not raws:
            return "give the layer to add under `layer`"
        placed, note = _insert(frame, raws, anchor)
        if not placed:
            return "that layer had nothing in it"
        if len(frame["layers"]) > MAX_LAYERS:
            del frame["layers"][MAX_LAYERS:]
            note += f" (layers past {MAX_LAYERS} were dropped)"
        return [f"added {', '.join(_describe(l) for l in placed)} to {frame['name']!r}{note}"]

    if name == "remove":
        refs = _layer_ids(item)
        if not refs:
            return "name the layer to remove"
        close = str(item.get("close_gap", True)).lower() not in ("false", "0", "no")
        out = []
        for ref in refs:
            found = wf.layer(ref, item.get("frame"))
            if isinstance(found, str):
                return found
            frame, layer = found
            frame["layers"].remove(layer)
            if close and not _is_backdrop(layer, frame):
                top, bottom = layer["y"], layer["y"] + layer["h"]
                # Only when the band it held is now empty: removing one of two
                # buttons in a row leaves the row where it was.
                shared = any(
                    l["y"] < bottom and l["y"] + l["h"] > top
                    for l in frame["layers"] if not _is_backdrop(l, frame)
                )
                if not shared:
                    shift = layer["h"] + 16
                    for other in frame["layers"]:
                        if not _is_backdrop(other, frame) and other["y"] >= bottom - 1:
                            other["y"] = round(max(top, other["y"] - shift), 2)
            out.append(f"removed {_describe(layer)}")
        return out

    if name == "order":
        refs = _layer_ids(item)
        to = plain_text(item.get("to") or item.get("value") or "front").lower()
        out = []
        for ref in refs:
            found = wf.layer(ref, item.get("frame"))
            if isinstance(found, str):
                return found
            frame, layer = found
            stack = frame["layers"]
            at = stack.index(layer)
            stack.pop(at)
            if to in ("front", "top"):
                stack.append(layer)
            elif to in ("back", "bottom"):
                stack.insert(0, layer)
            elif to in ("forward", "up"):
                stack.insert(min(len(stack), at + 1), layer)
            elif to in ("backward", "down"):
                stack.insert(max(0, at - 1), layer)
            else:
                stack.insert(at, layer)
                return "`to` is front, back, forward or backward"
            out.append(f"sent {_describe(layer)} {to}")
        return out or "name the layer to reorder"

    if name in ("align", "distribute"):
        refs = _layer_ids(item)
        found = [wf.layer(ref, item.get("frame")) for ref in refs]
        bad = next((f for f in found if isinstance(f, str)), None)
        if bad:
            return bad
        if not found:
            return "name the layers under `layers`"
        frames = {id(f) for f, _ in found}
        if len(frames) > 1:
            return "those layers are on different frames"
        frame = found[0][0]
        layers = [l for _, l in found]
        if name == "align":
            to = plain_text(item.get("to") or item.get("value") or "left").lower()
            pad = _padding(frame)
            if len(layers) == 1:
                left, top, right, bottom = pad, pad, frame["w"] - pad, frame["h"] - pad
            else:
                left = min(l["x"] for l in layers)
                top = min(l["y"] for l in layers)
                right = max(l["x"] + l["w"] for l in layers)
                bottom = max(l["y"] + l["h"] for l in layers)
            for l in layers:
                if to == "left":
                    l["x"] = left
                elif to in ("center", "centre"):
                    l["x"] = round((left + right - l["w"]) / 2, 2)
                elif to == "right":
                    l["x"] = round(right - l["w"], 2)
                elif to == "top":
                    l["y"] = top
                elif to in ("middle", "vcenter"):
                    l["y"] = round((top + bottom - l["h"]) / 2, 2)
                elif to == "bottom":
                    l["y"] = round(bottom - l["h"], 2)
                else:
                    return "`to` is left, center, right, top, middle or bottom"
            return [f"aligned {', '.join(l['id'] for l in layers)} {to}"]
        axis = plain_text(item.get("axis") or "vertical").lower()
        key, size = ("y", "h") if axis.startswith("v") else ("x", "w")
        if len(layers) < 2:
            return "distribute needs two or more layers"
        layers.sort(key=lambda l: l[key])
        gap = _num(item.get("gap"), None, 0, 2000)
        if gap is None:
            span = layers[-1][key] + layers[-1][size] - layers[0][key]
            used = sum(l[size] for l in layers)
            gap = max(0.0, (span - used) / (len(layers) - 1))
        at = layers[0][key]
        for l in layers:
            l[key] = round(at, 2)
            at += l[size] + gap
        return [f"spaced {', '.join(l['id'] for l in layers)} {gap:g}px apart"]

    if name == "add_frame":
        spec = item.get("frame") if isinstance(item.get("frame"), dict) else as_dict(item.get("frame"))
        if spec is None:
            # The frame given loose on the op, its name perhaps as `frame`.
            spec = {k: v for k, v in item.items() if k not in ("op", "action", "frame")}
            if isinstance(item.get("frame"), str) and not spec.get("name"):
                spec["name"] = item["frame"]
        if not isinstance(spec, dict):
            return "give the new frame under `frame`"
        spec = {k: v for k, v in spec.items() if k not in ("x", "y")}
        made = normalize_wireframe([spec])["frames"]
        if not made:
            return "that frame had nothing in it"
        if len(wf.frames) >= MAX_FRAMES:
            return f"a wireframe holds at most {MAX_FRAMES} frames"
        frame = made[0]
        new_id = wf.next_frame_id()
        frame["id"] = new_id
        for n, layer in enumerate(frame["layers"], start=1):
            layer["id"] = f"{new_id}_l{n}"
        right = max((f["x"] + f["w"] for f in wf.frames), default=-FRAME_GAP)
        frame["x"], frame["y"] = right + FRAME_GAP, 0
        # Links inside it were resolved against itself alone; the names they
        # carried are gone, so they are read again from the spec's layers.
        for layer, raw in zip(frame["layers"], [r for r in (spec.get("layers") or []) if r]):
            target = plain_text(raw.get("link") if isinstance(raw, dict) else "")
            if target:
                layer["link"] = target
        wf.frames.append(frame)
        return [f"added frame {new_id} {frame['name']!r} with {len(frame['layers'])} layers"]

    frame_ref = item.get("frame") if not isinstance(item.get("frame"), dict) else None
    if name in ("update_frame", "remove_frame", "duplicate_frame"):
        # The frame by `frame`, or by `name` when the new values are under
        # `set` and the name can only be the one it has now.
        frame_ref = frame_ref or item.get("screen") or item.get("id") or (
            item.get("name") if name != "duplicate_frame" and "set" in item else None
        )
        frame = wf.frame(frame_ref)
        if frame is None:
            names = ", ".join(f"{f['id']} {f['name']!r}" for f in wf.frames)
            return f"there is no frame {plain_text(frame_ref)!r} ({names})"
        if name == "remove_frame":
            if len(wf.frames) == 1:
                return "that is the only frame -- a wireframe needs one"
            wf.frames.remove(frame)
            return [f"removed frame {frame['id']} {frame['name']!r}"]
        if name == "duplicate_frame":
            if len(wf.frames) >= MAX_FRAMES:
                return f"a wireframe holds at most {MAX_FRAMES} frames"
            copy = json.loads(json.dumps(frame))
            new_id = wf.next_frame_id()
            copy["id"] = new_id
            copy["name"] = (plain_text(item.get("name") or item.get("name_new"))
                            or f"{frame['name']} copy")[:80]
            for n, layer in enumerate(copy["layers"], start=1):
                layer["id"] = f"{new_id}_l{n}"
            right = max(f["x"] + f["w"] for f in wf.frames)
            copy["x"], copy["y"] = right + FRAME_GAP, 0
            wf.frames.append(copy)
            return [f"duplicated {frame['name']!r} as frame {new_id} {copy['name']!r}"]
        changes = _changes(item)
        said = []
        new_name = plain_text(changes.get("name") or item.get("name_new") or changes.get("title"))
        if new_name:
            frame["name"] = new_name[:80]
            said.append(f"name {frame['name']!r}")
        preset = plain_text(changes.get("preset") or changes.get("device")).lower()
        if preset in FRAME_PRESETS:
            frame["w"], frame["h"] = map(float, FRAME_PRESETS[preset])
            said.append(f"size {preset}")
        for key, alias in (("w", "width"), ("h", "height")):
            value = _num(changes.get(key, changes.get(alias)), None, 100, 8000 if key == "h" else 4000)
            if value is not None:
                frame[key] = value
                said.append(f"{key} {value:g}")
        if "fill" in changes or "background" in changes:
            fill = _colour(changes.get("fill") or changes.get("background"))
            if fill:
                frame["fill"] = fill
                said.append(f"fill {fill}")
            else:
                frame.pop("fill", None)
                said.append("fill removed")
        if not said:
            return "nothing to change -- set name, preset, w, h or fill"
        return [f"frame {frame['id']}: " + ", ".join(said)]

    if name == "theme":
        changes = _changes(item)
        cleaned = clean_theme(changes)
        if not cleaned:
            return "no theme values could be read -- use background, surface, text, muted, accent, line and fonts"
        wf.doc["theme"] = {**(wf.doc.get("theme") or {}), **cleaned}
        return ["theme: " + ", ".join(f"{k} {v}" for k, v in cleaned.items())]

    if name == "fidelity":
        value = plain_text(item.get("value") or item.get("to") or item.get("fidelity")).lower()
        styled = value in ("styled", "hifi", "high", "high-fidelity", "mockup")
        wf.doc["fidelity"] = "styled" if styled else "wireframe"
        return [f"fidelity {wf.doc['fidelity']}"]

    return f"unknown op -- use one of {', '.join(OPS)}"


class EditWireframe(Skill):
    surfaces = "canvas"
    wants_session = True

    def __init__(self, store: Store) -> None:
        super().__init__(
            name="edit_wireframe",
            description=(
                "Change an existing wireframe in place, without redrawing it: "
                "restyle, move, add or remove layers, and add, rename, resize, "
                "duplicate or remove frames. Prefer this to write_wireframe for "
                "any revision -- untouched layers stay exactly where the user "
                "may have put them. Layers are named by id (f1_l3); read_canvas "
                "lists every id, box and property. `ops` is a list, applied in "
                "order: "
                "{op: 'update', layer, set: {text, fill, color, size, weight, "
                "variant, x, y, w, h, link, ...}} -- null removes a property; "
                "{op: 'add', frame, layer: {...} or layers: [...], after or "
                "before: a layer id} -- with no x/y it joins the stack below "
                "the anchor (or at the end) and what follows moves down; "
                "{op: 'remove', layer} -- the gap below closes; "
                "{op: 'move', layer, x, y or dx, dy}; "
                "{op: 'order', layer, to: 'front'|'back'|'forward'|'backward'}; "
                "{op: 'align', layers: [...], to: 'left'|'center'|'right'|'top'|"
                "'middle'|'bottom'} -- one layer aligns to its frame; "
                "{op: 'distribute', layers: [...], axis: 'vertical'|'horizontal', "
                "gap}; {op: 'add_frame', frame: {name, preset, layers}}; "
                "{op: 'update_frame', frame, set: {name, preset, w, h, fill}}; "
                "{op: 'duplicate_frame', frame, name}; {op: 'remove_frame', "
                "frame}; {op: 'theme', set: {accent, background, ...}}; "
                "{op: 'fidelity', value: 'styled'|'wireframe'}."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Which wireframe."},
                    "ops": {
                        "type": "array",
                        "description": "The changes, applied in order.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "op": {"type": "string", "enum": list(OPS)},
                                "layer": {
                                    "type": ["string", "object"],
                                    "description": "A layer id, or for add the new layer.",
                                },
                                "layers": {"type": "array", "items": {"type": ["string", "object"]}},
                                "frame": {
                                    "type": ["string", "object"],
                                    "description": "A frame id or name, or for add_frame the new frame.",
                                },
                                "set": {"type": "object", "description": "Properties to set."},
                                "after": {"type": "string"},
                                "before": {"type": "string"},
                                "to": {"type": "string"},
                                "x": {"type": "number"}, "y": {"type": "number"},
                                "dx": {"type": "number"}, "dy": {"type": "number"},
                                "axis": {"type": "string"},
                                "gap": {"type": "number"},
                                "name": {"type": "string"},
                                "value": {"type": "string"},
                            },
                        },
                    },
                },
                "required": ["title", "ops"],
            },
        )
        self.store = store

    async def use(self, session: str, title=None, ops=None, **extra) -> str:
        name = plain_text(title or extra.get("name"))
        canvas = self.store.find_canvas_by_title(session, name) if name else None
        if canvas is None or canvas.kind != KIND:
            found = [c for c in self.store.session_canvases(session) if c.kind == KIND]
            if len(found) == 1 and (canvas is None or canvas.kind != KIND) and not name:
                canvas = found[0]
            elif canvas is None or canvas.kind != KIND:
                listed = ", ".join(repr(c.title) for c in found) or "none"
                return f"There is no wireframe called {name!r}. Wireframes here: {listed}."
        try:
            doc = json.loads(canvas.content or "{}")
        except ValueError:
            return f"{canvas.title!r} could not be read as a wireframe."
        if ops is None:
            ops = next((extra[k] for k in ("operations", "changes", "edits") if k in extra), None)
        if not ops:
            return "No ops were given. Pass `ops` as a list, e.g. [{op: 'update', layer: 'f1_l2', set: {text: '...'}}]."

        done, failed = apply_ops(doc, ops)
        if not done:
            return "Nothing changed. " + " ".join(f + "." for f in failed)

        from .images import known_ids

        known = known_ids(self.store, session)
        dropped = []
        for frame in doc["frames"]:
            for layer in frame["layers"]:
                if layer.get("image") and layer["image"] not in known:
                    dropped.append(layer.pop("image"))
        self.store.update_canvas(canvas.id, content=json.dumps(doc, ensure_ascii=False))
        said = f"Edited the wireframe {canvas.title!r}: " + "; ".join(done) + "."
        if failed:
            said += " Not applied: " + " ".join(f + "." for f in failed)
        if dropped:
            said += f" Left off images that do not exist: {', '.join(dropped)} -- call list_images."
        from ..design_check import check_wireframe, summary

        said += summary(check_wireframe(doc))
        return said
