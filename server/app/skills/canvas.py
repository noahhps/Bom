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

import re

from ..store import Store
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
                "page, an interactive layout, or a slideshow, write a complete "
                "HTML document with kind 'html' -- its scripts and styles run in "
                "the preview, so self-contained pages work best. Pass the raw "
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

    async def use(
        self,
        session: str,
        title: str,
        content: str,
        kind: str | None = None,
        language: str | None = None,
    ) -> str:
        name = (title or "").strip()
        if not name:
            return "Give the canvas a title so it can be found and updated later."
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
        return (
            f"{verb} the canvas {canvas.title!r} ({lines} line"
            f"{'' if lines == 1 else 's'}). It is open in the side panel for the "
            "user to read and edit. Update it by calling write_canvas with the "
            "same title, or read it back first with read_canvas."
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

    async def use(self, session: str, title: str | None = None) -> str:
        canvases = self.store.session_canvases(session)
        if not canvases:
            return (
                "There are no canvases in this conversation yet. Make one with "
                "write_canvas."
            )

        name = (title or "").strip()
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
        if len(body) > MAX_READ_CHARS:
            body = (
                body[:MAX_READ_CHARS]
                + f"\n… cut here — the canvas is {len(canvas.content)} characters "
                "and the whole of it is in the panel."
            )
        return f"{header}\n{body}"
