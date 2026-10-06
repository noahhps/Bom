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

import difflib
import json
import re

from .. import design_check
from ..store import Store
from . import sheet as sheets
from .args import as_dict, plain_text
from . import slides as decks
from .patch import apply_edits, parse_edits, set_css_variables
from .skill import NOT_CODE, STUDIO, Skill

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

# How much of a canvas read_canvas hands back in one call, when the server does
# not say otherwise (CANVAS_READ_CHARS). Enough for the whole of a typical page:
# a revision that sees only the top of what it is revising loses the rest. A
# longer canvas is read in pages, by line.
MAX_READ_CHARS = 60_000


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


def _content_notes(store: Store, session: str, body: str) -> str:
    """What the model should hear about a canvas it has just written or edited:
    pictures that are not in the library, and pictures fetched from the web.
    """
    note = ""
    # The user's pictures, by id. One that is not in the library is a
    # picture that will not appear, so the model hears about it now.
    from .images import REFERENCE, known_ids

    named = set(REFERENCE.findall(body))
    unknown = sorted(named - known_ids(store, session)) if named else []
    if unknown:
        note += (
            f" WARNING: {', '.join(unknown)} "
            f"{'is' if len(unknown) == 1 else 'are'} not in this conversation's "
            "images, so nothing will show there. Call list_images for the real ids."
        )
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
        note += (
            f" WARNING: {len(remote)} "
            f"{'image' if len(remote) == 1 else 'images'} in this canvas "
            f"{'loads' if len(remote) == 1 else 'load'} from the internet "
            f"({named}), so the user is most likely seeing "
            "blank gaps where they should be. Unless they gave you those "
            "exact URLs, replace them now with edit_canvas, drawing the "
            "pictures inline -- an SVG, a CSS gradient, or a data: URI -- so "
            "the page stands on its own."
        )
    return note


def _check_note(kind: str, body: str) -> str:
    """The design check's plain breakages, for a page or a document."""
    if kind == "html":
        return design_check.summary(design_check.check_html(body))
    if kind == "markdown":
        return design_check.summary(design_check.check_markdown(body))
    return ""


class WriteCanvas(Skill):
    # A canvas, design or device tool: not offered in a code conversation.
    modes = NOT_CODE
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
                "for. The user's own pictures are the exception: call "
                "list_images and use <img src=\"bom-image:ID\"> (or "
                "![alt](bom-image:ID) in markdown). Link a remote image only "
                "when the user gave you that exact URL. Pass the raw "
                "content itself, not wrapped in a code fence. Writing to a title "
                "that already exists replaces that canvas whole -- to revise "
                "one, use edit_canvas, which changes only the parts you name. "
                "Keep your chat reply short when you do this; the work is in "
                "the panel."
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
        # A picture named by its file name rather than its id -- the name is
        # what the model saw when the user attached it.
        from .images import resolution_note, resolve_images_in_text

        body, matched = resolve_images_in_text(self.store, session, body)
        lang = (language or "").strip() or None
        resolved_kind = _normalize_kind(kind, lang)
        # Rescue a page the model wrote but labelled prose: stored as markdown
        # it would render escaped, as source. Only upgrades markdown -- an
        # explicit `code` kind means the user wants to see the HTML as text.
        # Not when the kind was pinned by the user's Make menu: a document
        # they asked for stays a document, whatever the model put in it.
        if resolved_kind == "markdown" and _looks_like_html(body) and not extra.get("kind_pinned"):
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
        note = resolution_note(matched)
        note += _content_notes(self.store, session, body)
        note += _check_note(resolved_kind, body)
        return (
            f"{verb} the canvas {canvas.title!r} ({lines} line"
            f"{'' if lines == 1 else 's'}). It is open in the side panel for the "
            "user to read and edit. Change part of it with edit_canvas, or "
            f"replace it by calling write_canvas with the same title.{note}"
        )


class ReadCanvas(Skill):
    # A canvas, design or device tool: not offered in a code conversation.
    modes = NOT_CODE
    wants_session = True

    def __init__(self, store: Store, max_chars: int = MAX_READ_CHARS, *, settings=None) -> None:
        super().__init__(
            name="read_canvas",
            description=(
                "Read a canvas back, so you can revise it without guessing at "
                "what it holds. Call with no title to see which canvases this "
                "conversation has; call with a title to get its current "
                "contents -- exactly as stored, so text you copy from it will "
                "match in edit_canvas. A wireframe comes back as its frames and "
                "layers with their ids, a deck as numbered slides, a sheet as a "
                "grid. The user may have edited it since you last wrote it. A "
                "long canvas comes back in parts: call again with `offset` for "
                "the rest."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Which canvas to read. Omit to list them.",
                    },
                    "offset": {
                        "type": "integer",
                        "description": "The line to start from, for a long canvas. Default 1.",
                    },
                },
            },
        )
        self.store = store
        self._max_chars = max_chars
        # When given, the page size is read from here on every call, so
        # Enterprise mode's larger reads apply without rebuilding the skill.
        self._settings = settings

    @property
    def max_chars(self) -> int:
        live = getattr(self._settings, "canvas_read_chars", None) if self._settings is not None else None
        return max(1000, int(live or self._max_chars))

    @property
    def max_result_chars(self) -> int:
        # The whole read has to survive the turn loop's cut on results, or the
        # paging here would be undone by the loop truncating the page.
        return self.max_chars + 2000

    async def use(self, session: str, title=None, offset=1, **extra) -> str:
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

        return paged(
            heading(canvas), readable(canvas), offset, self.max_chars,
            "Call read_canvas again with offset={next} for the rest; the whole "
            "canvas is in the panel.",
        )


def heading(canvas) -> str:
    """'Title (kind, language)' -- how a canvas is named back to the model."""
    return f"{canvas.title} ({canvas.kind}" + (
        f", {canvas.language}" if canvas.language else ""
    ) + ")"


def readable(canvas) -> str:
    """A canvas as a model reads it.

    The structured kinds are stored as JSON, which is a poor way to read a
    deck and a worse way to read a sheet. They come back in the shape the
    model would write them: an outline of screens and layers, an outline of
    slides, and a grid with its addresses. Everything else is its text.
    """
    body = canvas.content or "(empty)"
    if canvas.kind == sheets.KIND:
        loaded = sheets.load(canvas.content)
        if loaded is not None:
            body = sheets.as_text(loaded)
    elif canvas.kind == "wireframe":
        from .wireframe import outline as wireframe_outline

        try:
            body = wireframe_outline(json.loads(canvas.content or "{}"))
        except (ValueError, AttributeError, KeyError):
            pass
    elif canvas.kind == decks.KIND:
        try:
            body = decks.outline(json.loads(canvas.content or "{}"))
        except (ValueError, AttributeError):
            pass
    return body


def paged(header: str, body: str, offset, max_chars: int, more: str) -> str:
    """`body` under `header`, or one page of it from line `offset`.

    Paged by whole lines, so a page never ends halfway through the text the
    model is about to quote back in an edit. `more` says how to get the next
    page, with `{next}` for the line it starts on.
    """
    if len(body) <= max_chars and _as_int(offset, 1) <= 1:
        return f"{header}:\n{body}"
    lines = body.split("\n")
    start = min(max(1, _as_int(offset, 1)), len(lines))
    kept, used = [], 0
    for line in lines[start - 1:]:
        if kept and used + len(line) + 1 > max_chars:
            break
        kept.append(line[:max_chars])
        used += len(line) + 1
    end = start + len(kept) - 1
    page = "\n".join(kept)
    said = f"{header}, lines {start}-{end} of {len(lines)}:\n{page}"
    if end < len(lines):
        said += "\n… more below. " + more.format(next=end + 1)
    return said


def _as_int(value, default: int) -> int:
    try:
        return int(plain_text(value) if not isinstance(value, int) else value)
    except (TypeError, ValueError):
        return default


#: What each structured kind is edited with, for a call that reached the wrong tool.
_EDITED_WITH = {
    "slides": "edit_slides",
    "wireframe": "edit_wireframe",
    "sheet": "edit_sheet",
}


def _find_canvas(store: Store, session: str, name: str, kinds: set[str]):
    """The canvas `name` names, or the only one of `kinds` when none is named."""
    canvas = store.find_canvas_by_title(session, name) if name else None
    if canvas is None and not name:
        only = [c for c in store.session_canvases(session) if c.kind in kinds]
        canvas = only[0] if len(only) == 1 else None
    return canvas


def _line_change(before: str, after: str) -> str:
    added = removed = 0
    for line in difflib.unified_diff(before.splitlines(), after.splitlines(), lineterm="", n=0):
        if line.startswith("+") and not line.startswith("+++"):
            added += 1
        elif line.startswith("-") and not line.startswith("---"):
            removed += 1
    return f"+{added}/-{removed} lines"


class EditCanvas(Skill):
    """Part of a page, a document or a program, changed in place."""
    # A canvas, design or device tool: not offered in a code conversation.
    modes = NOT_CODE

    surfaces = "canvas"
    wants_session = True

    def __init__(self, store: Store) -> None:
        super().__init__(
            name="edit_canvas",
            description=(
                "Change part of a canvas -- a web page, a document or code -- "
                "without writing it all again. Use this, not write_canvas, for "
                "any revision short of starting over: only the text you name "
                "changes, so nothing else can be lost or garbled. Each edit is "
                "{find, replace}: `find` is text copied exactly from the canvas "
                "(read_canvas shows it) and must occur exactly once -- include "
                "enough around it to be unique, or set `all` to true to change "
                "every occurrence. {after: anchor, insert: text} or {before: "
                "anchor, insert: text} adds new text beside an anchor, and "
                "{delete: text} removes text. For an HTML page, `css_vars` sets "
                "custom properties on :root, e.g. {\"--accent\": \"#0B5FFF\"} -- "
                "the quickest way to restyle a page built on tokens. Edits apply "
                "in order; one that does not match is reported with the closest "
                "text in the canvas, so you can correct it and try again."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Which canvas to edit."},
                    "edits": {
                        "type": "array",
                        "description": "The changes, applied in order.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "find": {"type": "string", "description": "Exact text to change."},
                                "replace": {"type": "string", "description": "What it becomes."},
                                "all": {"type": "boolean", "description": "Change every occurrence."},
                                "after": {"type": "string", "description": "Anchor to insert after."},
                                "before": {"type": "string", "description": "Anchor to insert before."},
                                "insert": {"type": "string", "description": "Text to insert at the anchor."},
                                "delete": {"type": "string", "description": "Exact text to remove."},
                            },
                        },
                    },
                    "css_vars": {
                        "type": "object",
                        "description": "For a page: custom properties to set on :root, by name.",
                        "additionalProperties": {"type": "string"},
                    },
                },
                "required": ["title"],
            },
        )
        self.store = store

    async def use(self, session: str, title=None, edits=None, css_vars=None, **extra) -> str:
        name = plain_text(title or extra.get("name"))
        canvas = _find_canvas(self.store, session, name, KINDS)
        if canvas is None:
            here = [c.title for c in self.store.session_canvases(session) if c.kind in KINDS]
            listed = ", ".join(repr(t) for t in here) or "none yet"
            return f"There is no canvas called {name!r} to edit. Pages and documents here: {listed}."
        if canvas.kind in _EDITED_WITH:
            return (
                f"{canvas.title!r} is a {canvas.kind}, which is edited with "
                f"{_EDITED_WITH[canvas.kind]} rather than as text."
            )

        before = canvas.content or ""
        parsed, problems = parse_edits(edits if edits is not None else extra.get("changes"), extra)
        patched = apply_edits(before, parsed)
        after = patched.text
        applied = list(patched.applied)
        failed = problems + patched.failed

        variables = as_dict(css_vars) if css_vars is not None else None
        if variables:
            if canvas.kind == "html":
                after, changed = set_css_variables(after, variables)
                if changed:
                    applied.append("set " + ", ".join(changed))
            else:
                failed.append("css_vars only applies to an HTML page")

        from .images import resolution_note, resolve_images_in_text

        after, matched = resolve_images_in_text(self.store, session, after)
        if matched:
            applied.append("matched pictures by name")

        if not parsed and not variables:
            return (
                "No edits were given. Pass `edits` as a list of {find, replace}, "
                "with `find` copied from the canvas."
            )
        if after == before:
            said = f"Nothing changed in {canvas.title!r}."
            if failed:
                said += " " + " ".join(f"{f}." if not f.endswith("\n") else f for f in failed)
            return said.rstrip()

        self.store.update_canvas(canvas.id, content=after)
        count = len(applied)
        said = (
            f"Edited the canvas {canvas.title!r}: {count} change{'' if count == 1 else 's'} "
            f"({_line_change(before, after)}) -- " + "; ".join(applied) + "."
        )
        if failed:
            said += " Not applied: " + " ".join(
                f if f.endswith("\n") else f + "." for f in failed
            )
        if canvas.kind == "html":
            # Said on its own when this edit is what broke the markup: a patch
            # that drops a closing tag is the one way this tool can make a page
            # worse, and the model should hear that it was this edit.
            if design_check.balance_problems(after) > design_check.balance_problems(before):
                said += (
                    " This edit left the markup unbalanced -- check the tags "
                    "around what you changed."
                )
        said += resolution_note(matched)
        said += _content_notes(self.store, session, after)
        said += _check_note(canvas.kind, after)
        return said


class CheckDesign(Skill):
    """A design review of anything in the canvas panel."""
    # A canvas, design or device tool: not offered in a code conversation.
    modes = STUDIO

    wants_session = True

    def __init__(self, store: Store) -> None:
        super().__init__(
            name="check_design",
            description=(
                "Review a canvas the way a designer would before showing it: "
                "contrast, markup that does not balance, placeholder copy, "
                "layers off the edge of a screen or on top of each other, text "
                "too long for its box, too many typefaces, missing alt text, a "
                "deck that is all bullets. Run it on a page, wireframe or deck "
                "before you tell the user it is done, then fix what it finds "
                "with edit_canvas, edit_wireframe or edit_slides."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Which canvas to check."},
                },
            },
        )
        self.store = store

    async def use(self, session: str, title=None, **extra) -> str:
        name = plain_text(title or extra.get("name"))
        kinds = KINDS | set(_EDITED_WITH)
        canvas = _find_canvas(self.store, session, name, kinds)
        if canvas is None:
            here = [c.title for c in self.store.session_canvases(session)]
            listed = ", ".join(repr(t) for t in here) or "none yet"
            return f"There is no canvas called {name!r}. Canvases here: {listed}."
        findings = check_canvas(canvas.kind, canvas.content or "")
        if findings is None:
            return f"{canvas.title!r} is {canvas.kind}, which has no design to check."
        return f"Design check of {canvas.title!r} ({canvas.kind}):\n" + design_check.report(findings)


def check_canvas(kind: str, content: str) -> list | None:
    """Every finding for a canvas of `kind`, or None for a kind with no look."""
    if kind == "html":
        return design_check.check_html(content)
    if kind == "markdown":
        return design_check.check_markdown(content)
    if kind in ("wireframe", decks.KIND):
        try:
            doc = json.loads(content or "{}")
        except ValueError:
            return [design_check.Finding(design_check.FIX, "the document could not be read")]
        if kind == "wireframe":
            return design_check.check_wireframe(doc)
        return design_check.check_deck(doc)
    return None


class OpenCanvas(Skill):
    """Put a canvas in front of the user -- this conversation's, or a copy of
    one from another conversation."""
    # A canvas, design or device tool: not offered in a code conversation.
    modes = NOT_CODE

    surfaces = "canvas"
    wants_session = True

    def __init__(self, store: Store) -> None:
        super().__init__(
            name="open_canvas",
            description=(
                "Open a canvas in the side panel for the user: a document, deck, "
                "sheet, page or wireframe. Use it to show them something you are "
                "about to discuss or change, or to bring back work from another "
                "conversation -- a canvas found elsewhere is copied into this one "
                "(with its pictures) so it can be edited here. Call with no title "
                "to list the canvases in every conversation."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "The canvas to open."},
                },
            },
        )
        self.store = store

    async def use(self, session: str, title=None, **extra) -> str:
        name = plain_text(title or extra.get("name"))
        if not name:
            everything = self.store.all_canvases(limit=40)
            if not everything:
                return "There are no canvases in any conversation yet."
            lines = [
                f"- {c['title']} ({c['kind']}) in "
                + ("this conversation" if c["session_id"] == session
                   else f"\"{c['session_title'] or 'Untitled'}\"")
                for c in everything
            ]
            return "Canvases, newest first:\n" + "\n".join(lines)
        here = self.store.find_canvas_by_title(session, name)
        if here is not None:
            self.store.touch_canvas(here.id)
            return f"Opened {here.title!r} ({here.kind}) in the canvas panel."
        lowered = name.lower()
        match = next(
            (c for c in self.store.all_canvases(limit=500) if c["title"].lower() == lowered),
            None,
        ) or next(
            (c for c in self.store.all_canvases(limit=500) if lowered in c["title"].lower()),
            None,
        )
        if match is None:
            return (
                f"There is no canvas called {name!r} in any conversation. Call "
                "open_canvas with no title to see what there is."
            )
        copy = self.store.copy_canvas(match["id"], session)
        return (
            f"Opened a copy of {match['title']!r} ({match['kind']}) from the conversation "
            f"\"{match['session_title'] or 'Untitled'}\" as {copy.title!r} in this "
            "conversation's canvas panel. Edits here do not change the original."
        )
