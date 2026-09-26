"""The canvas, as two skills.

A canvas is a document that lives beside the conversation rather than inside
it: a draft, a snippet of code, a page the reader is building up with the
model's help. It is shown in a side panel the reader can edit by hand, and the
model reaches it through these two skills -- one to write it, one to read it
back before revising.

Named by title, not by id, for the same reason the calendar is: every listing
the model sees is prose, so an id would be something it had to be handed and
then copy back exactly, which a small local model gets wrong often enough to
matter. `write_canvas` on a title that already exists in this conversation
replaces that canvas; a new title makes a new one. One conversation rarely has
more than a handful, and telling them apart by name is what a person does too.

Both return a short sentence rather than the document. The reader is looking at
the panel; the model wrote the content and does not need it read back to it, and
a full copy in the result would burn the window for nothing. `read_canvas` is
the exception, and only because revising something means seeing it first.
"""

from __future__ import annotations

import json
import re

from ..store import Store
from . import sheet as sheets
from .args import plain_text
from . import slides as decks
from .skill import Skill

# A full HTML document, or a fragment that opens with a structural tag. Used to
# rescue content the model wrote as HTML but forgot to label -- stored as
# markdown it would be shown escaped, as source, which is the opposite of what
# a page is for.
_HTML_DOC = re.compile(r"<!doctype\s+html|<html[\s>]", re.IGNORECASE)
_HTML_TAG = re.compile(
    r"<(?:body|head|section|article|main|div|table|ul|ol|form|style|script|h[1-6]|p)[\s>]",
    re.IGNORECASE,
)


def _looks_like_html(text: str) -> bool:
    """Whether content is really HTML wearing the wrong label.

    Deliberately conservative: a full document (`<!doctype html>`/`<html>`) is
    unambiguous, and otherwise the content must actually begin with a tag and
    carry both a structural element and a closing tag. Prose with the odd inline
    `<img>` stays markdown -- only something that is plainly a page is rescued.
    """
    t = (text or "").strip()
    if not t:
        return False
    if _HTML_DOC.search(t):
        return True
    return t.startswith("<") and bool(_HTML_TAG.search(t)) and "</" in t

# An asset a page pulls in by address: an <img>, an SVG <image>, or a CSS
# url(). Only the reference is captured; whether it is remote is decided below.
_ASSET = re.compile(
    r"""(?:
          <img\b[^>]*?\bsrc\s*=\s*["']?(?P<img>[^"'\s>]+)
        | <image\b[^>]*?\bhref\s*=\s*["']?(?P<svg>[^"'\s>]+)
        | \burl\(\s*["']?(?P<css>[^"')]+)
    )""",
    re.IGNORECASE | re.VERBOSE,
)

#: How many hosts to name back before it stops being useful information.
_NAMED_HOSTS = 3


def _remote_assets(text: str) -> list[str]:
    """Every image in `text` that has to be fetched from somewhere else.

    This is the check behind the note in write_canvas's result. A model given
    no guidance reaches for the placeholder services it learned -- and they are
    the least reliable addresses on the web: the free ones get retired
    (source.unsplash.com), fall over for weeks at a time (via.placeholder.com),
    or want a photo id it invented rather than looked up. The page then renders
    as a finished layout with holes in it, which looks like Bom losing the
    pictures rather than the model naming ones that were never there.

    Protocol-relative `//host/...` counts: inside a srcdoc frame on an opaque
    origin it resolves to https all the same.

    `data:` URIs and relative paths are not remote and never flagged -- those
    are the shapes we are steering towards.
    """
    found: list[str] = []
    for hit in _ASSET.finditer(text or ""):
        url = (hit.group("img") or hit.group("svg") or hit.group("css") or "").strip()
        low = url.lower()
        if low.startswith(("http://", "https://")) or low.startswith("//"):
            found.append(url)
    return found


def _host_of(url: str) -> str:
    """The host part, for naming in the note. Best-effort and never raises."""
    rest = url.split("//", 1)[-1]
    return rest.split("/", 1)[0].split("?", 1)[0] or url


# What `kind` may be. Anything else is coerced to the closest sensible default
# rather than stored as-is -- the panel only knows how to render these three,
# and a canvas it cannot render is worse than one labelled plainly.
KINDS = {"markdown", "code", "html"}

# How much of a canvas read_canvas hands back. A canvas longer than this is cut
# with a note saying so: the model is revising, and the whole point of the
# panel is that the reader can see the parts the window cannot hold.
MAX_READ_CHARS = 6000


def _normalize_kind(kind: str | None, language: str | None) -> str:
    """The kind to store, given what the model asked for.

    A missing or unknown kind becomes `code` when a language was named -- "make
    a canvas in python" is a code canvas even when the model forgets to say so
    -- and `markdown` otherwise, which is the safe thing to render prose as.
    """
    value = (kind or "").strip().lower()
    if value in KINDS:
        return value
    return "code" if (language or "").strip() else "markdown"


class WriteCanvas(Skill):
    surfaces = "canvas"
    wants_session = True

    def __init__(self, store: Store) -> None:
        super().__init__(
            name="write_canvas",
            description=(
                "Create or replace a canvas -- a document shown to the user in a "
                "side panel, for a draft, a report, a block of code, or a web "
                "page you are building together. Use this instead of a long "
                "fenced block in the chat when the user will keep the result or "
                "edit it. For a document or prose, use kind 'markdown'; for a "
                "page, a poster, a dashboard or any interactive layout, write a "
                "complete HTML document with kind 'html' -- its scripts and "
                "styles run in the preview, so self-contained pages work best. "
                "For a presentation use write_slides instead, and for a table of "
                "numbers use write_sheet -- both draw far better than HTML. "
                "Before a page whose look matters, call ask_for_design if no "
                "standard has been chosen in this conversation, and declare the "
                "standard's colours and fonts as CSS custom properties. "
                "IMAGES: draw them, do not link them. Inline SVG, a CSS "
                "gradient, or a data: URI renders every time; a remote URL "
                "usually does not, because the placeholder services are dead or "
                "retired, a photo id you did not look up does not exist, and "
                "this machine may have no internet at all. It also sends the "
                "user's address to a stranger, which is the one thing Bom "
                "is for avoiding. Never emit via.placeholder.com, "
                "source.unsplash.com, images.unsplash.com, picsum.photos or "
                "similar -- an inline SVG with a shape and a caption is a better "
                "placeholder than a broken one, and says what the picture is "
                "for. Link a remote image only when the user gave you that exact "
                "URL. Pass the raw "
                "content itself, not wrapped in a code fence. Writing to a title "
                "that already exists replaces that canvas whole, so read_canvas "
                "first if you mean to revise rather than start over. Keep your "
                "chat reply short when you do this; the work is in the panel."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Short name for the canvas. Reusing one replaces it.",
                    },
                    "content": {
                        "type": "string",
                        "description": "The full new contents of the canvas.",
                    },
                    "kind": {
                        "type": "string",
                        "enum": sorted(KINDS),
                        "description": (
                            "How to show it: 'markdown' for prose, 'code' for a "
                            "program, 'html' for a page to preview. Defaults to "
                            "markdown, or code when a language is given."
                        ),
                    },
                    "language": {
                        "type": "string",
                        "description": "For a code canvas, the language, e.g. 'python'.",
                    },
                },
                "required": ["title", "content"],
            },
        )
        self.store = store

    def wants_design(self, arguments: dict) -> bool:
        """A page has a look; a code snippet or a plain draft does not.

        Only an explicit html kind, or content that is plainly a page, counts.
        Asking which design standard a Python script should follow would be a
        question with no sensible answer.
        """
        kind = str(arguments.get("kind") or "").strip().lower()
        if kind == "html":
            return True
        if kind in ("", "markdown"):
            return _looks_like_html(str(arguments.get("content") or ""))
        return False

    async def use(
        self,
        session: str,
        title=None,
        content="",
        kind: str | None = None,
        language: str | None = None,
        **extra,
    ) -> str:
        # Unwrapped if it came as an object; refused, with a sentence rather
        # than a TypeError, if it did not come at all.
        name = plain_text(title or extra.get("name"))[:200]
        if not name:
            return "Give the canvas a title so it can be found and updated later."
        # The body under another name, or as something other than text: an
        # object or a list would otherwise be stored as its Python repr.
        if not content:
            content = next((extra[k] for k in ("text", "body", "html", "markdown", "code") if k in extra), "")
        if not isinstance(content, str):
            content = plain_text(content)
        kind = plain_text(kind) or None
        language = plain_text(language) or None
        # The two structured kinds have their own tools, which take structure
        # rather than text. Content written here for them would be a document
        # the panel cannot draw.
        asked = (kind or "").strip().lower()
        if asked in ("slides", "deck", "presentation"):
            return "Use write_slides for a presentation -- it takes the slides as a list."
        if asked in ("sheet", "spreadsheet", "table", "csv"):
            return "Use write_sheet for a spreadsheet -- it takes the columns and rows."
        # content is allowed to be empty: clearing a canvas back to a blank
        # sheet is a real edit, and refusing it would make the model paste a
        # single space to get around the check.
        body = content or ""
        lang = (language or "").strip() or None
        resolved_kind = _normalize_kind(kind, lang)
        # Rescue a page the model wrote but labelled prose: stored as markdown
        # it would render escaped, as source. Only upgrades markdown -- an
        # explicit `code` kind means the user wants to see the HTML as text.
        if resolved_kind == "markdown" and _looks_like_html(body):
            resolved_kind = "html"

        existing = self.store.find_canvas_by_title(session, name)
        if existing is None:
            canvas = self.store.create_canvas(
                session, name, content=body, kind=resolved_kind, language=lang
            )
            verb = "Created"
        else:
            canvas = self.store.update_canvas(
                existing.id,
                content=body,
                kind=resolved_kind,
                language=lang,
            )
            verb = "Updated"

        lines = body.count("\n") + 1 if body else 0
        note = ""
        # Said in the result as well as the description, because the
        # description is read once before the model has written anything and
        # this arrives holding the actual page. It is a report, not a refusal:
        # the canvas is already saved, and a URL the user supplied is a good
        # reason to keep it. What it buys is the model finding out now, while
        # it can still fix it, rather than the reader finding out from a gap
        # where the picture should be.
        remote = _remote_assets(body)
        if remote:
            hosts: list[str] = []
            for url in remote:
                host = _host_of(url)
                if host not in hosts:
                    hosts.append(host)
            named = ", ".join(hosts[:_NAMED_HOSTS])
            if len(hosts) > _NAMED_HOSTS:
                named += f" and {len(hosts) - _NAMED_HOSTS} more"
            note = (
                f" WARNING: {len(remote)} "
                f"{'image' if len(remote) == 1 else 'images'} in this canvas "
                f"{'loads' if len(remote) == 1 else 'load'} from the internet "
                f"({named}), so the user is most likely seeing "
                "blank gaps where they should be. Unless they gave you those "
                "exact URLs, rewrite the canvas now with the pictures drawn "
                "inline -- an SVG, a CSS gradient, or a data: URI -- so the "
                "page stands on its own."
            )

        return (
            f"{verb} the canvas {canvas.title!r} ({lines} line"
            f"{'' if lines == 1 else 's'}). It is open in the side panel for the "
            "user to read and edit. Update it by calling write_canvas with the "
            f"same title, or read it back first with read_canvas.{note}"
        )


class ReadCanvas(Skill):
    wants_session = True

    def __init__(self, store: Store) -> None:
        super().__init__(
            name="read_canvas",
            description=(
                "Read a canvas back, so you can revise it without guessing at "
                "what it holds. Call with no title to see which canvases this "
                "conversation has; call with a title to get its current "
                "contents. The user may have edited it since you last wrote it."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Which canvas to read. Omit to list them.",
                    }
                },
            },
        )
        self.store = store

    async def use(self, session: str, title=None, **extra) -> str:
        canvases = self.store.session_canvases(session)
        if not canvases:
            return (
                "There are no canvases in this conversation yet. Make one with "
                "write_canvas."
            )

        name = plain_text(title)
        if not name:
            listed = "\n".join(
                f"- {c.title} ({c.kind}"
                + (f", {c.language}" if c.language else "")
                + ")"
                for c in canvases
            )
            return f"Canvases in this conversation:\n{listed}"

        canvas = self.store.find_canvas_by_title(session, name)
        if canvas is None:
            available = ", ".join(repr(c.title) for c in canvases)
            return f"There is no canvas called {name!r}. There is: {available}."

        body = canvas.content or "(empty)"
        header = f"{canvas.title} ({canvas.kind}" + (
            f", {canvas.language}" if canvas.language else ""
        ) + "):"
        # The structured kinds are stored as JSON, which is a poor way to read a
        # deck and a worse way to read a sheet. Both come back in the shape the
        # model would write them: an outline, and a grid with its addresses.
        if canvas.kind == sheets.KIND:
            loaded = sheets.load(canvas.content)
            if loaded is not None:
                body = sheets.as_text(loaded)
        elif canvas.kind == decks.KIND:
            try:
                body = decks.outline(json.loads(canvas.content or "{}"))
            except (ValueError, AttributeError):
                pass
        if len(body) > MAX_READ_CHARS:
            body = (
                body[:MAX_READ_CHARS]
                + f"\n… cut here — the canvas is {len(canvas.content)} characters "
                "and the whole of it is in the panel."
            )
        return f"{header}\n{body}"
