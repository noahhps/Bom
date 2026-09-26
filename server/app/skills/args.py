"""Reading tool arguments the way a model actually sends them.

A schema says `title` is a string. A small local model will still send
`{"title": "Aesthetic Summary"}`, `["Aesthetic Summary"]`, or the Python repr of
one of those as a string -- and `str()` on any of them puts braces and quotes
on a slide. These helpers turn whatever arrived into the plain text it meant,
so every tool that writes something the reader sees reads its text one way.
"""

from __future__ import annotations

import ast
import json

#: Keys a wrapped value is most likely hiding its text under, in order.
_TEXT_KEYS = (
    "text", "title", "value", "content", "label", "name", "heading", "body",
    "caption", "quote", "subtitle", "description",
)


def _parse_wrapped(text: str):
    """A string that is really a serialised dict or list, parsed; else None."""
    t = text.strip()
    if len(t) < 2 or t[0] not in "{[" or t[-1] not in "}]":
        return None
    for parse in (json.loads, ast.literal_eval):
        try:
            value = parse(t)
        except (ValueError, SyntaxError, TypeError, MemoryError, RecursionError):
            continue
        if isinstance(value, (dict, list)):
            return value
    return None


def plain_text(value, *, depth: int = 0) -> str:
    """The text a value stands for, however it was wrapped.

    Dicts give up the first of the usual text keys, or failing that their
    values joined; lists join their items one per line; a string that is a
    serialised dict or list is unwrapped the same way. Depth-limited, so a
    pathological argument cannot recurse forever.
    """
    if value is None or depth > 6:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        wrapped = _parse_wrapped(value)
        if wrapped is not None:
            return plain_text(wrapped, depth=depth + 1)
        return value.strip()
    if isinstance(value, dict):
        for key in _TEXT_KEYS:
            if key in value:
                found = plain_text(value[key], depth=depth + 1)
                if found:
                    return found
        parts = [plain_text(v, depth=depth + 1) for v in value.values()]
        return " — ".join(p for p in parts if p)
    if isinstance(value, (list, tuple)):
        parts = [plain_text(v, depth=depth + 1) for v in value]
        return "\n".join(p for p in parts if p)
    return str(value).strip()


def as_dict(value) -> dict | None:
    """An object argument, whether it came as a dict or as its JSON text."""
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        parsed = _parse_wrapped(value)
        return parsed if isinstance(parsed, dict) else None
    return None
