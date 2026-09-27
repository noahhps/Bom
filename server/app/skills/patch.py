"""Changing part of a document without writing all of it again.

Rewriting a whole page to move one heading is how revisions go wrong: the
model has to reproduce twenty thousand characters it only half remembers, and
whatever it misremembers is lost. A patch names the part that changes and
leaves everything else exactly as it was.

Find-and-replace is the shape every model already knows. The text to find has
to occur once -- if it occurs more often the edit is refused, with the count,
rather than guessing which one was meant -- unless `all` asks for every one.

Two concessions to how models actually quote a document back:

* **whitespace.** A find that differs from the document only in indentation
  or line breaks still matches, once exact matching has failed. HTML does
  not care about either, and a model re-indenting a snippet it copied is the
  commonest way for an exact match to miss.
* **a miss says where.** When nothing matches, the result quotes the closest
  lines in the document, so the next attempt can copy them rather than
  guess again.

Edits apply in order, each to the result of the one before. One that fails is
reported and skipped; the rest still apply, because a model told that three of
four changes landed fixes the fourth, where one told that nothing happened
tends to start over from scratch.
"""

from __future__ import annotations

import difflib
import re
from dataclasses import dataclass, field

from .args import as_dict, plain_text

MAX_EDITS = 40

_FIND_KEYS = ("find", "old", "old_string", "old_text", "search", "from", "target", "match")
_REPLACE_KEYS = ("replace", "new", "new_string", "new_text", "replacement", "with", "to")
_ALL_KEYS = ("all", "replace_all", "every", "global")


@dataclass
class Edit:
    find: str
    replace: str = ""
    every: bool = False
    # For an insertion: where the new text goes relative to `find`.
    insert: str | None = None  # "before" | "after"


@dataclass
class Patched:
    text: str
    applied: list[str] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)


def _truthy(value) -> bool:
    return value is True or str(value).strip().lower() in ("true", "1", "yes", "all")


def _raw_text(value) -> str:
    """A find or replace value as the text it is, whitespace and all.

    `plain_text` strips, which is right for a title and wrong here: the
    newline at the end of a replacement is part of the replacement.
    """
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    return plain_text(value)


def parse_edits(edits, extra: dict | None = None) -> tuple[list[Edit], list[str]]:
    """The edits a model sent, however it shaped them, and what could not be read.

    Accepts a list of {find, replace, all}, one such object on its own, the
    same as JSON text, or `find`/`replace` given at the top level of the call.
    Insertions are {after: anchor, insert: text} or {before: anchor, insert:
    text}; a deletion is {delete: text}.
    """
    extra = extra or {}
    listed = edits
    if isinstance(listed, str):
        parsed = as_dict(listed)
        if parsed is not None:
            listed = [parsed]
        else:
            import json

            try:
                listed = json.loads(listed)
            except ValueError:
                listed = []
    if isinstance(listed, dict):
        inner = next((v for v in listed.values() if isinstance(v, list)), None)
        listed = inner if inner is not None and not any(k in listed for k in _FIND_KEYS) else [listed]
    if not isinstance(listed, list):
        listed = []
    if not listed and any(k in extra for k in _FIND_KEYS + ("delete", "after", "before")):
        listed = [extra]

    out: list[Edit] = []
    problems: list[str] = []
    for number, raw in enumerate(listed[:MAX_EDITS], start=1):
        item = raw if isinstance(raw, dict) else as_dict(raw)
        if not isinstance(item, dict):
            problems.append(f"edit {number} is not an object with find and replace")
            continue
        every = any(_truthy(item.get(k)) for k in _ALL_KEYS if k in item)
        if "delete" in item or "remove" in item:
            target = _raw_text(item.get("delete", item.get("remove")))
            out.append(Edit(find=target, replace="", every=every))
            continue
        if ("after" in item or "before" in item) and ("insert" in item or "text" in item or "content" in item):
            side = "after" if "after" in item else "before"
            content = item.get("insert", item.get("text", item.get("content")))
            out.append(Edit(find=_raw_text(item[side]), replace=_raw_text(content),
                            every=every, insert=side))
            continue
        find_key = next((k for k in _FIND_KEYS if k in item), None)
        replace_key = next((k for k in _REPLACE_KEYS if k in item), None)
        if find_key is None:
            problems.append(f"edit {number} has no `find`")
            continue
        out.append(Edit(
            find=_raw_text(item[find_key]),
            replace=_raw_text(item[replace_key]) if replace_key else "",
            every=every,
        ))
    if len(listed) > MAX_EDITS:
        problems.append(f"only the first {MAX_EDITS} edits were read")
    return out, problems


def _loose(find: str) -> re.Pattern | None:
    """`find` as a pattern that ignores how its whitespace is laid out."""
    tokens = find.split()
    if not tokens:
        return None
    return re.compile(r"\s+".join(re.escape(t) for t in tokens))


def _preview(text: str, limit: int = 60) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"


def closest(text: str, find: str, limit: int = 400) -> str | None:
    """The run of lines in `text` most like `find`, for a miss to quote."""
    lines = text.splitlines()
    wanted = [line.strip() for line in find.strip().splitlines() if line.strip()]
    if not lines or not wanted:
        return None
    size = len(wanted)
    target = "\n".join(wanted)
    best, where = 0.0, 0
    # Anchor on the lines most like the first line of the find, then score the
    # window that starts there -- cheaper than scoring every window outright.
    first = wanted[0]
    candidates = sorted(
        range(len(lines)),
        key=lambda i: difflib.SequenceMatcher(None, lines[i].strip(), first).quick_ratio(),
        reverse=True,
    )[:25]
    for start in candidates:
        window = "\n".join(line.strip() for line in lines[start:start + size])
        score = difflib.SequenceMatcher(None, window, target).ratio()
        if score > best:
            best, where = score, start
    if best < 0.4:
        return None
    snippet = "\n".join(lines[where:where + size])
    return snippet if len(snippet) <= limit else snippet[:limit] + "…"


def apply_edits(text: str, edits: list[Edit]) -> Patched:
    result = Patched(text=text)
    for number, edit in enumerate(edits, start=1):
        if not edit.find:
            result.failed.append(
                f"edit {number}: `find` is empty -- quote the text to change, or use "
                "an anchor with after/before and insert"
            )
            continue

        current = result.text
        spans: list[tuple[int, int]] = []
        loosely = False
        start = current.find(edit.find)
        while start != -1:
            spans.append((start, start + len(edit.find)))
            start = current.find(edit.find, start + max(1, len(edit.find)))
        if not spans:
            pattern = _loose(edit.find)
            if pattern is not None:
                spans = [(m.start(), m.end()) for m in pattern.finditer(current)]
                loosely = bool(spans)

        if not spans:
            near = closest(current, edit.find)
            said = f"edit {number}: nothing matches {_preview(edit.find)!r}"
            if near:
                said += f". The closest text is:\n{near}\n"
            else:
                said += " -- read_canvas to see the current text"
            result.failed.append(said)
            continue
        if len(spans) > 1 and not edit.every:
            result.failed.append(
                f"edit {number}: {_preview(edit.find)!r} occurs {len(spans)} times -- "
                "quote more of the surrounding text so it is unique, or set all: true"
            )
            continue

        pieces: list[str] = []
        last = 0
        for begin, end in spans:
            matched = current[begin:end]
            if edit.insert == "after":
                new = matched + edit.replace
            elif edit.insert == "before":
                new = edit.replace + matched
            else:
                new = edit.replace
            pieces.append(current[last:begin])
            pieces.append(new)
            last = end
        pieces.append(current[last:])
        result.text = "".join(pieces)

        verb = {"after": "inserted after", "before": "inserted before"}.get(edit.insert or "", "")
        if not verb:
            verb = "deleted" if not edit.replace else "replaced"
        count = f" ({len(spans)} places)" if len(spans) > 1 else ""
        note = " (matched ignoring whitespace)" if loosely else ""
        result.applied.append(f"{verb} {_preview(edit.find, 40)!r}{count}{note}")
    return result


_ROOT_BLOCK = re.compile(r":root\s*\{", re.I)


def set_css_variables(html: str, values: dict) -> tuple[str, list[str]]:
    """Set custom properties on the page's :root, adding any that are missing.

    The cheapest restyle there is: a page built on tokens changes colour by
    changing six values, with nothing else touched.
    """
    changed: list[str] = []
    for raw_name, raw_value in values.items():
        name = plain_text(raw_name).strip()
        value = plain_text(raw_value).strip().rstrip(";")
        if not name or not value or re.search(r"[{};<>]", value):
            continue
        if not name.startswith("--"):
            name = "--" + name.lstrip("-")
        if not re.fullmatch(r"--[\w-]+", name):
            continue
        declared = re.compile(rf"({re.escape(name)}\s*:\s*)([^;}}]*)")
        root = _ROOT_BLOCK.search(html)
        # Prefer the declaration inside :root, since a dark-mode block may
        # redeclare the same name further down.
        hit = None
        if root:
            hit = declared.search(html, root.end())
        hit = hit or declared.search(html)
        if hit:
            html = html[:hit.start(2)] + value + html[hit.end(2):]
        elif root:
            html = html[:root.end()] + f"\n  {name}: {value};" + html[root.end():]
        else:
            block = f"<style>\n:root {{\n  {name}: {value};\n}}\n</style>\n"
            head = re.search(r"<head[^>]*>", html, re.I)
            if head:
                html = html[:head.end()] + "\n" + block + html[head.end():]
            else:
                html = block + html
        changed.append(f"{name}: {value}")
    return html, changed
