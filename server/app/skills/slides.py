"""Presentations, as a canvas the client draws.

A deck is not written as HTML. It is a list of slides, each with a layout and
the few fields that layout needs, plus one theme -- and the canvas panel draws
it. That split is the whole design:

* **the model writes content, not CSS.** A small local model asked for a
  twelve-slide HTML deck spends the turn on stylesheets and gets the content
  wrong; asked for twelve titled lists it gets the content right, and every
  slide comes out aligned to the same grid because the grid is not its job;

* **the look is a handful of values.** `theme` is the same set of tokens a
  design preset carries, so a standard chosen after the deck was written can
  still restyle it without a second generation -- see the turn loop;

* **the reader can edit it.** Structured slides can be edited in place in the
  panel, reordered, presented full screen and exported, none of which is
  possible against a blob of someone else's HTML.

Stored as JSON in an ordinary canvas row with kind "slides", so everything the
canvas already does -- the panel, the switcher, deletion with the chat -- comes
for free.
"""

from __future__ import annotations

import json
import re

from ..design_presets import clean_theme
from .args import _parse_wrapped, as_dict, plain_text
from ..store import Store
from .skill import Skill

KIND = "slides"

#: The layouts the panel knows how to draw. Anything else is mapped to the
#: nearest by what fields the slide actually carries -- see `_layout_for`.
LAYOUTS = (
    "title",       # kicker, title, subtitle -- the opening
    "section",     # title, subtitle on the accent -- a divider
    "bullets",     # title, bullets[, body]
    "content",     # title, body -- a short paragraph or two
    "two_column",  # title, left_title, left, right_title, right
    "stat",        # title, stats[{value, label}] -- one to four big numbers
    "quote",       # quote, attribution
    "image",       # title, visual (inline SVG), caption
    "table",       # title, columns[], rows[][]
    "closing",     # title, subtitle -- the ending
    "photo",       # image full-bleed, kicker/title/subtitle over it
    "split",       # image on one side, title and bullets/body on the other
    "board",       # a wireframe frame, drawn from its layers -- see wireframe.py
)

#: How an image may be fitted into its frame.
FITS = ("cover", "contain")

MAX_SLIDES = 60
MAX_BULLETS = 8
# Past these the panel still draws the slide, but the result says so: a slide
# with nine bullets is a document that has been cut into rectangles.
ADVISE_BULLETS = 5
ADVISE_BULLET_WORDS = 16
ADVISE_TITLE_WORDS = 12

_TEXT_FIELDS = (
    "kicker", "title", "subtitle", "body", "left_title", "left",
    "right_title", "right", "quote", "attribution", "caption", "notes",
)
_MARKDOWN_FIELDS = {"body", "left", "right", "notes"}
_SVG = re.compile(r"^\s*<svg[\s>]", re.IGNORECASE)
_REMOTE = re.compile(r"""(?:href|src)\s*=\s*["']?\s*(?:https?:)?//""", re.IGNORECASE)


def _as_list(value) -> list:
    """A list argument, however it arrived: a list, JSON or repr text, lines,
    or an object wrapping a list (`{"items": [...]}`)."""
    if value is None or value == "":
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        inner = next((v for v in value.values() if isinstance(v, list)), None)
        return inner if inner is not None else [value]
    if isinstance(value, str):
        text = value.strip()
        if text[:1] in "[{":
            parsed = as_dict(text)
            if parsed is not None:
                return _as_list(parsed)
            try:
                listed = json.loads(text)
            except ValueError:
                listed = None
            if isinstance(listed, list):
                return listed
            listed = _parse_wrapped(text)  # the Python repr form, ['a', 'b']
            if isinstance(listed, list):
                return listed
        return [line.strip(" -*•\t") for line in text.splitlines() if line.strip(" -*•\t")]
    return [value]


def _text(value) -> str:
    """A field's text. A list becomes markdown bullet lines, which is what the
    two-column and body fields render; anything wrapped is unwrapped."""
    if isinstance(value, list):
        lines = [plain_text(v) for v in value]
        return "\n".join(f"- {line}" for line in lines if line)
    return plain_text(value)


def _bullet(value) -> str:
    """One bullet. A `{title, text}` pair keeps both halves, as "Title: text",
    rather than losing whichever key the unwrapper did not reach first."""
    item = as_dict(value) if not isinstance(value, dict) else value
    if isinstance(item, dict):
        head = plain_text(item.get("title") or item.get("label") or item.get("heading") or item.get("name"))
        body = plain_text(item.get("text") or item.get("body") or item.get("value")
                          or item.get("description") or item.get("content"))
        if head and body:
            return f"{head}: {body}"
        return head or body or plain_text(item)
    return plain_text(value)


# What models call the fields when they do not use our names.
_ALIASES = {
    "heading": "title", "header": "title", "headline": "title", "name": "title",
    "subheading": "subtitle", "subheader": "subtitle", "tagline": "subtitle",
    "text": "body", "paragraph": "body", "description": "body",
    "points": "bullets", "items": "bullets", "list": "bullets",
    "speaker_notes": "notes", "note": "notes",
    "author": "attribution", "source": "attribution",
    "eyebrow": "kicker", "label_top": "kicker",
}
# Containers a model sometimes nests a slide's fields inside.
_NESTS = ("content", "fields", "data", "slide", "properties", "props")


def _flatten(raw: dict) -> dict:
    """A slide's fields at the top level, under our names."""
    flat: dict = {}
    for key in _NESTS:
        nested = as_dict(raw.get(key))
        if nested is not None:
            flat.update(_flatten(nested))
    for key, value in raw.items():
        if key in _NESTS and as_dict(value) is not None:
            continue
        name = _ALIASES.get(key, key)
        if name not in flat or key == name:
            flat[name] = value
    return flat


def _layout_for(raw: dict, index: int) -> str:
    """The layout a slide asked for, or the one its fields imply."""
    named = str(raw.get("layout") or raw.get("type") or "").strip().lower()
    named = named.replace("-", "_").replace(" ", "_")
    aliases = {
        "cover": "title", "intro": "title", "hero": "title",
        "divider": "section", "list": "bullets", "text": "content",
        "comparison": "two_column", "columns": "two_column", "compare": "two_column",
        "stats": "stat", "number": "stat", "metric": "stat", "metrics": "stat",
        "visual": "image", "diagram": "image", "chart": "image",
        "end": "closing", "thanks": "closing", "outro": "closing",
        "full_image": "photo", "full_bleed": "photo", "hero_image": "photo",
        "background": "photo", "picture": "photo", "cover_image": "photo",
        "image_left": "split", "image_right": "split", "side_by_side": "split",
        "media": "split", "image_text": "split",
    }
    named = aliases.get(named, named)
    if named in LAYOUTS:
        return named
    if raw.get("quote"):
        return "quote"
    if raw.get("stats") or raw.get("stat"):
        return "stat"
    if raw.get("columns") and raw.get("rows"):
        return "table"
    if raw.get("left") or raw.get("right"):
        return "two_column"
    if raw.get("image") and (raw.get("bullets") or raw.get("body")):
        return "split"
    if raw.get("image"):
        return "photo"
    if raw.get("visual"):
        return "image"
    if raw.get("bullets") or raw.get("points"):
        return "bullets"
    if index == 0:
        return "title"
    return "content" if raw.get("body") else "bullets"


def normalize_slide(raw, index: int) -> dict | None:
    """One slide as it is stored, or None if there is nothing on it."""
    if isinstance(raw, str):
        raw = as_dict(raw) or {"title": raw}
    if not isinstance(raw, dict):
        return None
    raw = _flatten(raw)
    slide: dict = {"layout": _layout_for(raw, index)}
    for key in _TEXT_FIELDS:
        # Only the fields drawn as markdown may become a list of lines; a title
        # that arrived as ["Numbers"] is the word, not a bullet.
        text = _text(raw.get(key)) if key in _MARKDOWN_FIELDS else plain_text(raw.get(key)).replace("\n", " ")
        if text:
            slide[key] = text

    bullets = [_bullet(b) for b in _as_list(raw.get("bullets"))]
    bullets = [b for b in bullets if b][:MAX_BULLETS]
    if bullets:
        slide["bullets"] = bullets

    stats = []
    for item in _as_list(raw.get("stats")):
        item = as_dict(item) or item
        if isinstance(item, dict):
            value = plain_text(item.get("value") or item.get("stat") or item.get("number"))
            label = plain_text(item.get("label") or item.get("text") or item.get("description"))
        else:
            value, label = _text(item), ""
        if value:
            stats.append({"value": value, "label": label})
    if not stats and raw.get("stat"):
        stats.append({"value": _text(raw.get("stat")), "label": _text(raw.get("label"))})
    if stats:
        slide["stats"] = stats[:4]

    columns = [plain_text(c) for c in _as_list(raw.get("columns"))]
    if columns:
        slide["columns"] = columns[:8]
        rows = []
        for row in _as_list(raw.get("rows"))[:14]:
            if isinstance(row, dict):
                cells = [row.get(c, "") for c in columns] if any(c in row for c in columns) else list(row.values())
            else:
                cells = row if isinstance(row, list) else _as_list(row)
            rows.append([plain_text(c) for c in cells][: len(columns)])
        slide["rows"] = rows

    board = as_dict(raw.get("board")) if not isinstance(raw.get("board"), dict) else raw.get("board")
    if slide["layout"] == "board" or board:
        from .wireframe import normalize_wireframe  # local: wireframe imports slides

        frame = (board or {}).get("frame") or board
        cleaned = normalize_wireframe([frame], (board or {}).get("fidelity")) if frame else None
        if cleaned and cleaned["frames"]:
            slide["layout"] = "board"
            slide["board"] = {"fidelity": cleaned["fidelity"], "frame": cleaned["frames"][0]}
        elif slide["layout"] == "board":
            slide["layout"] = "content"

    picture = _image_ref(raw.get("image") or raw.get("photo") or raw.get("picture"))
    if picture:
        slide["image"] = picture

    visual = raw.get("visual") or raw.get("svg")
    if isinstance(visual, str) and _SVG.match(visual):
        slide["visual"] = visual.strip()

    return slide if len(slide) > 1 else None


_IMAGE_ID = re.compile(r"img_[A-Za-z0-9]+")


def _image_ref(value) -> dict | None:
    """A slide's picture: {id, fit, side, alt}, from an id or an object.

    Only an id from the library is kept. A web address is dropped here rather
    than stored -- the whole point of the library is that nothing on a slide is
    fetched from anywhere.
    """
    if value is None or value == "":
        return None
    item = as_dict(value) if not isinstance(value, dict) else value
    if item is None:
        item = {"id": value}
    ref = plain_text(item.get("id") or item.get("image") or item.get("src") or item.get("value"))
    hit = _IMAGE_ID.search(ref)
    if not hit:
        return None
    fit = plain_text(item.get("fit")).lower()
    side = plain_text(item.get("side") or item.get("position")).lower()
    picture = {"id": hit.group(0), "fit": fit if fit in FITS else "cover"}
    if side in ("left", "right"):
        picture["side"] = side
    alt = plain_text(item.get("alt") or item.get("description"))
    if alt:
        picture["alt"] = alt[:300]
    return picture


def check_images(deck: dict, known: set[str], generated: set[str] = frozenset()) -> list[str]:
    """Drop pictures that are not in the library; say which, for the model.

    A generated picture is marked so on the slide, which is what draws its
    "AI-generated" credit -- decided here from the library, never taken from
    what the model claims.
    """
    missing: list[str] = []
    for number, slide in enumerate(deck["slides"], start=1):
        picture = slide.get("image")
        if not picture:
            continue
        picture.pop("generated", None)
        if picture["id"] not in known:
            missing.append(f"slide {number} ({picture['id']})")
            del slide["image"]
        elif picture["id"] in generated:
            picture["generated"] = True
    return missing


def normalize_deck(slides, theme=None, defaults: dict | None = None,
                   override: dict | None = None) -> dict:
    """The stored document: a version, a theme and the slides.

    The theme is layered: the session's standard fills anything the model left
    out, what the model passed wins over that, and an override -- a standard
    picked after the deck was written -- wins over both.
    """
    listed = _as_list(slides)
    normalized = [s for s in (normalize_slide(raw, i) for i, raw in enumerate(listed)) if s]
    merged = {**clean_theme(defaults or {}), **clean_theme(theme), **clean_theme(override or {})}
    return {"version": 1, "theme": merged, "slides": normalized[:MAX_SLIDES]}


def advice(deck: dict) -> list[str]:
    """What a designer would flag before this deck went in front of anyone.

    Said in the result, not enforced: the deck is already saved and shown. It
    gives the model the chance to fix it in the same turn rather than the reader
    finding out on slide seven.
    """
    slides = deck["slides"]
    crowded, wordy, titled, remote = [], [], [], []
    for number, slide in enumerate(slides, start=1):
        bullets = slide.get("bullets", [])
        if len(bullets) > ADVISE_BULLETS:
            crowded.append(number)
        if any(len(b.split()) > ADVISE_BULLET_WORDS for b in bullets):
            wordy.append(number)
        if len(slide.get("title", "").split()) > ADVISE_TITLE_WORDS:
            titled.append(number)
        if _REMOTE.search(slide.get("visual", "")):
            remote.append(number)

    def which(numbers: list[int]) -> str:
        named = ", ".join(str(n) for n in numbers[:6]) + ("…" if len(numbers) > 6 else "")
        return f"slide{'' if len(numbers) == 1 else 's'} {named}"

    notes: list[str] = []
    if crowded:
        notes.append(f"{which(crowded)} {'has' if len(crowded) == 1 else 'have'} more than "
                     f"{ADVISE_BULLETS} bullets -- split or cut")
    if wordy:
        notes.append(f"{which(wordy)} {'has' if len(wordy) == 1 else 'have'} bullets over "
                     f"{ADVISE_BULLET_WORDS} words -- tighten them")
    if titled:
        notes.append(f"{which(titled)} {'has a' if len(titled) == 1 else 'have'} long "
                     "title -- state the point in a few words")
    if remote:
        notes.append(f"{which(remote)} load visuals from the internet -- draw them inline")
    if len(slides) >= 4:
        layouts = {s["layout"] for s in slides}
        if layouts <= {"bullets", "title", "closing"}:
            notes.append(
                "every content slide is a bullet list -- vary the rhythm with a "
                "section, a stat, a quote or a two-column slide"
            )
    if slides and not deck["theme"]:
        notes.append("no theme was given -- pass the design standard's colours and fonts as `theme`")
    return notes


def outline(deck: dict) -> str:
    """A deck as a model can read it back: numbered, one line a field."""
    lines = [f"theme: {json.dumps(deck.get('theme') or {})}"]
    for number, slide in enumerate(deck.get("slides", []), start=1):
        lines.append(f"{number}. [{slide.get('layout')}] {slide.get('title', '')}".rstrip())
        for key in ("kicker", "subtitle", "body", "left_title", "left", "right_title",
                    "right", "quote", "attribution", "caption"):
            if slide.get(key):
                lines.append(f"   {key}: {slide[key]}")
        for bullet in slide.get("bullets", []):
            lines.append(f"   - {bullet}")
        for stat in slide.get("stats", []):
            lines.append(f"   stat: {stat['value']} -- {stat['label']}")
        if slide.get("columns"):
            lines.append(f"   columns: {' | '.join(slide['columns'])}")
            for row in slide.get("rows", []):
                lines.append(f"   row: {' | '.join(row)}")
        if slide.get("visual"):
            lines.append(f"   visual: <svg, {len(slide['visual'])} chars>")
        if slide.get("image"):
            lines.append(f"   image: {json.dumps(slide['image'])}")
        if slide.get("notes"):
            lines.append(f"   notes: {slide['notes']}")
    return "\n".join(lines)


#: The theme argument, shared with write_sheet. Every key optional: the
#: conversation's standard fills whatever is left out.
THEME_SCHEMA = {
    "type": "object",
    "description": (
        "The look, taken from the design standard: colours as hex, fonts as CSS "
        "font stacks. Anything left out comes from the conversation's standard."
    ),
    "properties": {
        "background": {"type": "string"},
        "surface": {"type": "string"},
        "text": {"type": "string"},
        "muted": {"type": "string"},
        "accent": {"type": "string"},
        "accent_2": {"type": "string"},
        "line": {"type": "string"},
        "heading_font": {"type": "string"},
        "body_font": {"type": "string"},
        "heading_weight": {"type": "integer"},
        "heading_case": {"type": "string", "enum": ["none", "upper"]},
        "radius": {"type": "integer"},
    },
}


def save_canvas(store: Store, session: str, title: str, content: str, kind: str) -> str:
    """Create or replace a canvas by title. Returns "Created" or "Updated"."""
    existing = store.find_canvas_by_title(session, title)
    if existing is None:
        store.create_canvas(session, title, content=content, kind=kind)
        return "Created"
    store.update_canvas(existing.id, content=content, kind=kind)
    return "Updated"


class WriteSlides(Skill):
    surfaces = "canvas"
    wants_session = True
    #: Styled from the conversation's design standard. The turn loop passes the
    #: standard's tokens in as `design_defaults`, and asks for a standard first
    #: if the conversation has never chosen one -- see `needs_design`.
    themed = True
    needs_design = True

    def __init__(self, store: Store) -> None:
        super().__init__(
            name="write_slides",
            description=(
                "Create or replace a slide deck, shown in the canvas panel where "
                "the user can page through it, edit it, present it full screen "
                "and export it. Use this -- not write_canvas -- for any "
                "presentation, pitch, talk, lesson or walkthrough. Call "
                "ask_for_design first if no design standard has been chosen in "
                "this conversation, then put that standard's colours and fonts "
                "in `theme`. "
                "Each slide is an object with a `layout` and that layout's "
                "fields: title {kicker, title, subtitle}; section {title, "
                "subtitle}; bullets {title, bullets[]}; content {title, body}; "
                "two_column {title, left_title, left, right_title, right}; stat "
                "{title, stats[{value, label}] -- one to four big numbers}; "
                "quote {quote, attribution}; image {title, visual or image, "
                "caption} where visual is an inline <svg> you draw; table "
                "{title, columns[], rows[][]}; closing {title, subtitle}; photo "
                "{image, kicker, title, subtitle} -- a picture filling the slide "
                "with the words over it; split {image, title, bullets[] or body} "
                "-- a picture beside the text. `image` is the id of one of the "
                "user's pictures from list_images, or {id, fit: 'cover' or "
                "'contain', side: 'left' or 'right', alt}, or one made with "
                "generate_image; never a web address. "
                "Any slide may carry `notes` -- what the speaker says. "
                "Write a deck a designer would: open with a title slide, one idea "
                "per slide, titles that state the point, at most five short "
                "bullets, and vary the layouts. Reusing a title replaces that "
                "deck whole -- to revise one, use edit_slides. Keep your chat "
                "reply short; the deck is in the panel."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "The deck's name. Reusing one replaces it.",
                    },
                    "slides": {
                        "type": "array",
                        "description": "The slides, in order.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "layout": {"type": "string", "enum": list(LAYOUTS)},
                                "kicker": {"type": "string"},
                                "title": {"type": "string"},
                                "subtitle": {"type": "string"},
                                "bullets": {"type": "array", "items": {"type": "string"}},
                                "body": {"type": "string"},
                                "left_title": {"type": "string"},
                                "left": {"type": "string"},
                                "right_title": {"type": "string"},
                                "right": {"type": "string"},
                                "stats": {
                                    "type": "array",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "value": {"type": "string"},
                                            "label": {"type": "string"},
                                        },
                                    },
                                },
                                "quote": {"type": "string"},
                                "attribution": {"type": "string"},
                                "visual": {"type": "string"},
                                "image": {
                                    "type": ["string", "object"],
                                    "description": "An image id from list_images, or {id, fit, side, alt}.",
                                },
                                "caption": {"type": "string"},
                                "columns": {"type": "array", "items": {"type": "string"}},
                                "rows": {
                                    "type": "array",
                                    "items": {"type": "array", "items": {"type": "string"}},
                                },
                                "notes": {"type": "string"},
                            },
                        },
                    },
                    "theme": THEME_SCHEMA,
                },
                "required": ["title", "slides"],
            },
        )
        self.store = store

    async def use(
        self,
        session: str,
        title=None,
        slides=None,
        theme=None,
        design_defaults: dict | None = None,
        theme_override: dict | None = None,
        **extra,
    ) -> str:
        # The deck under another name, which a model sends as often as not.
        if slides is None:
            slides = next((extra[k] for k in ("deck", "pages", "content", "items") if k in extra), None)
        deck = normalize_deck(slides, theme, design_defaults, theme_override)
        # A missing title is not worth a failed call: the first slide's title
        # names the deck, and it can be renamed in the panel.
        name = plain_text(title or extra.get("name")) or (
            deck["slides"][0].get("title") if deck["slides"] else ""
        ) or "Untitled deck"
        name = name[:200]
        if not deck["slides"]:
            return (
                "That deck had no slides with anything on them. Pass `slides` as "
                "a list of objects, each with a layout and a title."
            )
        from .images import generated_ids, known_ids  # local: avoids an import cycle

        missing = check_images(deck, known_ids(self.store, session), generated_ids(self.store, session))
        content = json.dumps(deck, ensure_ascii=False, indent=1)
        verb = save_canvas(self.store, session, name, content, KIND)
        count = len(deck["slides"])
        said = (
            f"{verb} the deck {name!r} ({count} slide{'' if count == 1 else 's'}). "
            "It is open in the canvas panel, where the user can page through, "
            "edit, present and export it. Change it with edit_slides (read_canvas "
            "shows the slides by number)."
        )
        flags = advice(deck)
        if missing:
            flags.insert(0, "these images do not exist and were left off: "
                         + ", ".join(missing) + " -- call list_images for the real ids")
        if flags:
            said += " Before you finish, consider: " + "; ".join(flags) + "."
        return said


# -- editing in place ------------------------------------------------------------

_SLIDE_OPS = ("update", "add", "remove", "move", "duplicate", "theme")
_SLIDE_OP_ALIASES = {
    "set": "update", "edit": "update", "change": "update", "replace": "update",
    "insert": "add", "append": "add", "new": "add", "create": "add",
    "delete": "remove", "drop": "remove", "reorder": "move", "copy": "duplicate",
    "set_theme": "theme", "restyle": "theme",
}
_SLIDE_OP_KEYS = {"op", "action", "slide", "at", "after", "before", "to", "set", "changes",
                  "props", "fields", "number", "index"}


def _slide_number(value) -> int | None:
    try:
        return int(plain_text(value) if not isinstance(value, int) else value)
    except (TypeError, ValueError):
        return None


def apply_slide_ops(deck: dict, ops) -> tuple[list[str], list[str]]:
    """Apply `ops` to `deck` in place. Returns (what was done, what was not).

    Slide numbers mean the deck as it was read, before any of these ops ran:
    "remove 3, then update 5" means the fifth slide the model was looking at,
    not whatever slid into fifth place once the third had gone.
    """
    listed = _as_list(ops)
    slides: list[dict] = deck.setdefault("slides", [])
    original = list(slides)
    done: list[str] = []
    failed: list[str] = []

    def find(value, number: int) -> dict | str:
        n = _slide_number(value)
        if n is None or not 1 <= n <= len(original):
            return f"op {number}: there is no slide {plain_text(value) or '?'} (the deck has {len(original)})"
        slide = original[n - 1]
        if not any(s is slide for s in slides):
            return f"op {number}: slide {n} was already removed"
        return slide

    def position(slide: dict) -> int:
        return next(i for i, s in enumerate(slides) if s is slide)

    for number, raw in enumerate(listed[:60], start=1):
        item = raw if isinstance(raw, dict) else as_dict(raw)
        if not isinstance(item, dict):
            failed.append(f"op {number} is not an object")
            continue
        verb = plain_text(item.get("op") or item.get("action")).lower().replace(" ", "_")
        verb = _SLIDE_OP_ALIASES.get(verb, verb)
        if not verb:
            verb = "add" if isinstance(item.get("slide"), dict) else "update"

        if verb == "update":
            target = find(item.get("slide", item.get("number", item.get("index"))), number)
            if isinstance(target, str):
                failed.append(target)
                continue
            changes = next(
                (item[k] for k in ("set", "changes", "props", "fields") if isinstance(item.get(k), dict)),
                None,
            ) or {k: v for k, v in item.items() if k not in _SLIDE_OP_KEYS}
            if not changes:
                failed.append(f"op {number}: nothing to set -- put the fields under `set`")
                continue
            merged = dict(target)
            for key, value in changes.items():
                if value is None:
                    merged.pop(_ALIASES.get(key, key), None)
                    merged.pop(key, None)
                else:
                    merged[key] = value
            at = position(target)
            cleaned = normalize_slide(merged, at)
            if cleaned is None:
                failed.append(f"op {number}: that would leave slide {at + 1} empty -- remove it instead")
                continue
            slides[at] = cleaned
            original[original.index(target)] = cleaned
            done.append(f"updated slide {at + 1} ({cleaned['layout']})")

        elif verb in ("add", "duplicate"):
            if verb == "duplicate":
                source = find(item.get("slide"), number)
                if isinstance(source, str):
                    failed.append(source)
                    continue
                new = json.loads(json.dumps(source))
                anchor = ("after", source)
            else:
                spec = item.get("slide") if isinstance(item.get("slide"), dict) else as_dict(item.get("slide"))
                if spec is None:
                    spec = {k: v for k, v in item.items() if k not in _SLIDE_OP_KEYS}
                new = normalize_slide(spec, len(slides))
                if new is None:
                    failed.append(f"op {number}: that slide had nothing on it")
                    continue
                anchor = None
                for side in ("after", "before"):
                    if item.get(side) not in (None, ""):
                        found = find(item[side], number)
                        if isinstance(found, str):
                            failed.append(found)
                            anchor = "bad"
                        else:
                            anchor = (side, found)
                        break
                if anchor == "bad":
                    continue
                if anchor is None and _slide_number(item.get("at")) is not None:
                    # `at` is where it should end up, 1 for first.
                    at = max(1, min(len(slides) + 1, _slide_number(item["at"])))
                    slides.insert(at - 1, new)
                    done.append(f"added slide {at} ({new['layout']})")
                    continue
            if len(slides) >= MAX_SLIDES:
                failed.append(f"op {number}: a deck holds at most {MAX_SLIDES} slides")
                continue
            if anchor is None:
                slides.append(new)
                at = len(slides)
            else:
                at = position(anchor[1]) + (1 if anchor[0] == "after" else 0)
                slides.insert(at, new)
                at += 1
            done.append(f"{'duplicated as' if verb == 'duplicate' else 'added'} slide {at} ({new['layout']})")

        elif verb == "remove":
            targets = item.get("slides") if isinstance(item.get("slides"), list) else [item.get("slide")]
            for value in targets:
                target = find(value, number)
                if isinstance(target, str):
                    failed.append(target)
                    continue
                if len(slides) == 1:
                    failed.append(f"op {number}: that is the only slide")
                    continue
                slides.pop(position(target))
                done.append(f"removed slide {plain_text(value)} of the original")

        elif verb == "move":
            target = find(item.get("slide"), number)
            if isinstance(target, str):
                failed.append(target)
                continue
            to = _slide_number(item.get("to") or item.get("at"))
            if to is None:
                failed.append(f"op {number}: say where it goes with `to` (1 for first)")
                continue
            slides.pop(position(target))
            to = max(1, min(len(slides) + 1, to))
            slides.insert(to - 1, target)
            done.append(f"moved a slide to position {to}")

        elif verb == "theme":
            changes = item.get("set") if isinstance(item.get("set"), dict) else {
                k: v for k, v in item.items() if k not in _SLIDE_OP_KEYS
            }
            cleaned = clean_theme(changes)
            if not cleaned:
                failed.append(f"op {number}: no theme values could be read")
                continue
            deck["theme"] = {**(deck.get("theme") or {}), **cleaned}
            done.append("theme: " + ", ".join(f"{k} {v}" for k, v in cleaned.items()))

        else:
            failed.append(f"op {number}: unknown op {verb!r} -- use one of {', '.join(_SLIDE_OPS)}")
    return done, failed


class EditSlides(Skill):
    surfaces = "canvas"
    wants_session = True

    def __init__(self, store: Store) -> None:
        super().__init__(
            name="edit_slides",
            description=(
                "Change an existing deck without rewriting it: edit some slides' "
                "fields, add, remove, reorder or duplicate slides, or restyle the "
                "theme. Prefer this to write_slides for any revision -- slides "
                "you do not name stay exactly as they are, including the user's "
                "own edits. Slides are numbered from 1 as read_canvas shows them, "
                "and every number in one call means the deck as it was before "
                "the call. `ops`, applied in order: {op: 'update', slide, set: "
                "{title, bullets, body, layout, stats, image, notes, ...}} -- "
                "null removes a field; {op: 'add', slide: {layout, ...}, after "
                "or before: a number, or at: the position it should take}; "
                "{op: 'remove', slide}; {op: 'move', slide, to}; {op: "
                "'duplicate', slide}; {op: 'theme', set: {accent, background, "
                "...}}."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Which deck."},
                    "ops": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "op": {"type": "string", "enum": list(_SLIDE_OPS)},
                                "slide": {
                                    "type": ["integer", "object"],
                                    "description": "A slide number, or for add the new slide.",
                                },
                                "set": {"type": "object", "description": "Fields to set."},
                                "after": {"type": "integer"},
                                "before": {"type": "integer"},
                                "at": {"type": "integer"},
                                "to": {"type": "integer"},
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
            decks = [c for c in self.store.session_canvases(session) if c.kind == KIND]
            if len(decks) == 1 and not name:
                canvas = decks[0]
            else:
                listed = ", ".join(repr(c.title) for c in decks) or "none"
                return f"There is no deck called {name!r}. Decks here: {listed}."
        try:
            deck = json.loads(canvas.content or "{}")
        except ValueError:
            return f"{canvas.title!r} could not be read as a deck."
        if ops is None:
            ops = next((extra[k] for k in ("operations", "changes", "edits") if k in extra), None)
        if not ops:
            return "No ops were given. Pass `ops`, e.g. [{op: 'update', slide: 2, set: {title: '...'}}]."

        done, failed = apply_slide_ops(deck, ops)
        if not done:
            return "Nothing changed. " + " ".join(f + "." for f in failed)
        from .images import generated_ids, known_ids  # local: avoids an import cycle

        missing = check_images(deck, known_ids(self.store, session), generated_ids(self.store, session))
        self.store.update_canvas(canvas.id, content=json.dumps(deck, ensure_ascii=False, indent=1))
        count = len(deck["slides"])
        said = (
            f"Edited the deck {canvas.title!r}, now {count} slide{'' if count == 1 else 's'}: "
            + "; ".join(done) + "."
        )
        if failed:
            said += " Not applied: " + " ".join(f + "." for f in failed)
        if missing:
            said += (" These images do not exist and were left off: " + ", ".join(missing)
                     + " -- call list_images for the real ids.")
        from ..design_check import check_theme, summary

        said += summary(check_theme(deck.get("theme")))
        return said
