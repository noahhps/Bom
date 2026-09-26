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
)

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
        "comparison": "two_column", "columns": "two_column", "split": "two_column",
        "stats": "stat", "number": "stat", "metric": "stat", "metrics": "stat",
        "visual": "image", "diagram": "image", "chart": "image",
        "end": "closing", "thanks": "closing", "outro": "closing",
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

    visual = raw.get("visual") or raw.get("svg")
    if isinstance(visual, str) and _SVG.match(visual):
        slide["visual"] = visual.strip()

    return slide if len(slide) > 1 else None


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
                "quote {quote, attribution}; image {title, visual, caption} "
                "where visual is an inline <svg> you draw; table {title, "
                "columns[], rows[][]}; closing {title, subtitle}. Any slide may "
                "carry `notes` -- what the speaker says. "
                "Write a deck a designer would: open with a title slide, one idea "
                "per slide, titles that state the point, at most five short "
                "bullets, and vary the layouts. Reusing a title replaces that "
                "deck whole. Keep your chat reply short; the deck is in the panel."
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
        content = json.dumps(deck, ensure_ascii=False, indent=1)
        verb = save_canvas(self.store, session, name, content, KIND)
        count = len(deck["slides"])
        said = (
            f"{verb} the deck {name!r} ({count} slide{'' if count == 1 else 's'}). "
            "It is open in the canvas panel, where the user can page through, "
            "edit, present and export it. Update it by calling write_slides with "
            "the same title, or read it back first with read_canvas."
        )
        flags = advice(deck)
        if flags:
            said += " Before you finish, consider: " + "; ".join(flags) + "."
        return said
