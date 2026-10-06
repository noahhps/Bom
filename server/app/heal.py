"""Self-healing tool calls: mend what a model got nearly right.

A small model asks for the right skill in the wrong spelling more often than
it asks for the wrong skill. `functions.web_search`, `webSearch`, `web_serach`;
`{"Query": ...}`; `{"arguments": {"query": ...}}`; `"days": "7"`. Each of these
has exactly one thing it can have meant, and refusing it costs a round, a
second approval prompt and, on a local model, the better part of a minute --
for an answer the harness already knew.

So a call is mended before it is asked about, against the schemas this turn
actually offered, and only where the meaning is unambiguous:

- a name that is an offered tool's name once prefixes, stray template tokens,
  case and separators are set aside, or a near-unique typo of one;
- arguments wrapped one level deep in `arguments` / `parameters` / `input`;
- an argument name that is a declared one's in another case or spelling, or a
  near-unique typo of one that was not otherwise given;
- a value the schema types differently: "7" for an integer, "true" for a
  boolean, the JSON text of a list for a list, one item for a list of them,
  "Markdown" for an enum's "markdown"; and a null for an optional argument is
  dropped so the skill's own default applies.

What cannot be mended is not guessed at. A call whose arguments did not
decode, or that left out everything it requires, is answered with what the
tool expects instead of being run -- the model gets one round to send it
properly, which is what a person would get.

Renames are reported back beside the result, so the model sees its own
mistake and spells it right on the next call rather than leaning on this.
"""

from __future__ import annotations

import dataclasses
import difflib
import re
from dataclasses import dataclass, field
from typing import Any

from .providers.base import ToolCall, decode_arguments
from .skills.args import _parse_wrapped

#: How close a misspelling must be to count as one. High on purpose: a
#: near-miss of 0.85 is a typo (`web_serach`), where lower starts matching
#: different tools that share a word (`read_page` and `read_my_browser`).
CLOSE = 0.85

#: Keys a model wraps its real arguments in, copying an API's envelope.
_ENVELOPES = ("arguments", "args", "parameters", "params", "input", "kwargs")

#: Prefixes models put on a tool name: the namespace OpenAI's harness shows
#: gpt-oss, and the ones other chat templates use.
_PREFIXES = ("functions.", "function.", "tools.", "tool.", "default_api.")


@dataclass(frozen=True)
class Healed:
    call: ToolCall
    #: Said to the model beside the result. Only renames -- a coerced type is
    #: not a mistake worth a sentence.
    notes: tuple[str, ...] = ()
    #: Set when the call cannot run as it stands; the text is its answer.
    problem: str | None = None


@dataclass
class _Offered:
    schemas: dict[str, dict] = field(default_factory=dict)

    @classmethod
    def of(cls, tools: list[dict] | None) -> "_Offered":
        return cls({t["name"]: t.get("parameters") or {} for t in tools or () if t.get("name")})


def heal(call: ToolCall, tools: list[dict] | None) -> Healed:
    """The call as it was meant, against the tools this turn offered."""
    offered = _Offered.of(tools)
    notes: list[str] = []

    name = call.name
    if name not in offered.schemas:
        found = match_name(name, offered.schemas)
        if found is not None:
            notes.append(f"there is no tool {name!r}; ran {found!r}")
            name = found

    schema = offered.schemas.get(name)
    if schema is None:
        # Not a tool this turn has. Left as it is: the turn loop already
        # answers an unknown name with the list of real ones.
        return Healed(dataclasses.replace(call, name=name), tuple(notes))

    if call.unreadable is not None:
        return Healed(
            dataclasses.replace(call, name=name),
            tuple(notes),
            problem=(
                f"{name} did not run: its arguments were not valid JSON, so "
                "there was nothing to run it with. That usually means a long "
                "value with unescaped quotes or newlines. Send the call again "
                "with the arguments encoded properly -- a long value is fine, "
                "it only has to be escaped. " + usage(name, schema)
            ),
        )

    arguments = _unwrap(dict(call.arguments), schema, name)
    arguments = _rename(arguments, schema, notes)
    arguments = _coerce(arguments, schema)
    healed = dataclasses.replace(call, name=name, arguments=arguments)

    required = [r for r in schema.get("required") or () if isinstance(r, str)]
    if required and not arguments:
        return Healed(
            healed,
            tuple(notes),
            problem=f"{name} did not run: it was called with no arguments. " + usage(name, schema),
        )
    return Healed(healed, tuple(notes))


def match_name(name: str, offered) -> str | None:
    """The offered tool a mangled name stands for, or None."""
    names = list(offered)
    if not name or not names:
        return None
    cleaned = _clean_name(name)
    if cleaned in offered:
        return cleaned
    keyed = {_key(n): n for n in names}
    if _key(cleaned) in keyed:
        return keyed[_key(cleaned)]
    return _closest(_key(cleaned), keyed)


def usage(name: str, schema: dict) -> str:
    """One line on how to call a tool, for a model that called it wrongly."""
    properties = schema.get("properties") or {}
    required = set(schema.get("required") or ())
    if not properties:
        return f"{name} takes no arguments."
    parts = []
    for key, spec in properties.items():
        kind = (spec or {}).get("type") if isinstance(spec, dict) else None
        kind = "/".join(kind) if isinstance(kind, list) else kind
        label = f"{key} ({kind})" if kind else key
        parts.append(label + ("" if key in required else ", optional"))
    return f"{name} takes: " + "; ".join(parts) + "."


def note_for(notes) -> str:
    if not notes:
        return ""
    return (
        "\n\n(This call was mended before it ran: " + "; ".join(notes)
        + ". Use the exact names next time.)"
    )


# -- calls written out as text ------------------------------------------------

_TAGGED = re.compile(r"<tool_call>\s*(.*?)\s*(?:</tool_call>|$)", re.S)
_FENCED = re.compile(r"^```(?:json|tool_call|tool_code)?\s*\n?(.*?)\n?```$", re.S)


def calls_in_text(text: str, tools: list[dict] | None) -> tuple[ToolCall, ...]:
    """Tool calls a model wrote into its reply instead of making them.

    Chat templates that the backend cannot parse leave the call in the text --
    `<tool_call>{"name": ..., "arguments": ...}</tool_call>`, or the bare JSON,
    or the JSON in a fence. Read as calls only when that is all the reply is
    and every name is an offered tool's: a reply that *shows* some JSON, or
    explains a call, is an answer and stays one.
    """
    offered = _Offered.of(tools)
    stripped = (text or "").strip()
    if not offered.schemas or not stripped:
        return ()

    if stripped.startswith("<tool_call>"):
        bodies = _TAGGED.findall(stripped)
        if _TAGGED.sub("", stripped).strip():
            return ()
    else:
        fenced = _FENCED.match(stripped)
        bodies = [fenced.group(1) if fenced else stripped]
        if not bodies[0].lstrip().startswith(("{", "[")):
            return ()

    found: list[dict] = []
    for body in bodies:
        value = _parse_wrapped(body.strip())
        if value is None:
            value, unreadable = decode_arguments(body)
            if unreadable is not None:
                return ()
        found.extend(value if isinstance(value, list) else [value])

    calls: list[ToolCall] = []
    for index, entry in enumerate(found):
        if not isinstance(entry, dict):
            return ()
        if isinstance(entry.get("function"), dict):  # the OpenAI envelope
            entry = entry["function"]
        name = entry.get("name") or entry.get("tool") or entry.get("tool_name")
        if not isinstance(name, str):
            return ()
        cleaned = _clean_name(name)
        # Exact once cleaned, never a fuzzy match: a near-miss in a reply is
        # too likely to be prose about a tool rather than a call to it.
        if cleaned not in offered.schemas:
            keyed = {_key(n): n for n in offered.schemas}
            cleaned = keyed.get(_key(cleaned))
            if cleaned is None:
                return ()
        # The arguments in an envelope, or -- flatter -- beside the name.
        raw = next(
            (entry[k] for k in _ENVELOPES if k in entry),
            {k: v for k, v in entry.items() if k not in ("name", "tool", "tool_name", "id", "type")},
        )
        arguments, unreadable = decode_arguments(raw)
        calls.append(
            ToolCall(id=f"text_call_{index}", name=cleaned, arguments=arguments, unreadable=unreadable)
        )
    return tuple(calls)


# -- the pieces ---------------------------------------------------------------


def _clean_name(name: str) -> str:
    text = name.strip()
    # gpt-oss's channel markers, and any other template token, after the name.
    text = text.split("<|", 1)[0].strip()
    for prefix in _PREFIXES:
        if text.lower().startswith(prefix):
            text = text[len(prefix):]
    return text.strip().strip("`'\"").removesuffix("()").strip()


def _key(name: str) -> str:
    """A name with case and word separators set aside: webSearch, Web-Search
    and web_search all key to websearch."""
    snake = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", name)
    return re.sub(r"[\s_\-.]+", "", snake).lower()


def _closest(key: str, keyed: dict[str, str]) -> str | None:
    # One slipped key -- a letter dropped, doubled, swapped with its
    # neighbour -- is a typo at any length, where a similarity ratio
    # undersells it on a short word (`fersh` is 0.8 of `fresh`).
    if len(key) >= 4:
        slips = [k for k in keyed if _one_slip(key, k)]
        if len(slips) == 1:
            return keyed[slips[0]]
        if slips:
            return None
    found = difflib.get_close_matches(key, list(keyed), n=2, cutoff=CLOSE)
    if len(found) == 1:
        return keyed[found[0]]
    if len(found) == 2:
        # Two candidates nearly as close: whichever is picked could be the
        # wrong one, so neither is.
        first, second = (difflib.SequenceMatcher(None, key, f).ratio() for f in found)
        if first - second >= 0.05:
            return keyed[found[0]]
    return None


def _one_slip(a: str, b: str) -> bool:
    """Whether a and b differ by one edit: an insertion, a deletion, a
    substitution, or two neighbours swapped."""
    if a == b or abs(len(a) - len(b)) > 1:
        return False
    if len(a) == len(b):
        diff = [i for i in range(len(a)) if a[i] != b[i]]
        if len(diff) == 1:
            return True
        return (
            len(diff) == 2
            and diff[1] == diff[0] + 1
            and a[diff[0]] == b[diff[1]]
            and a[diff[1]] == b[diff[0]]
        )
    short, long = (a, b) if len(a) < len(b) else (b, a)
    i = 0
    while i < len(short) and short[i] == long[i]:
        i += 1
    return short[i:] == long[i + 1:]


def _unwrap(arguments: dict, schema: dict, name: str) -> dict:
    properties = schema.get("properties") or {}
    # {"name": "web_search", "arguments": {...}} -- the whole call, as the
    # arguments. The name is the tool's own, so it is not an argument.
    if (
        arguments.get("name") == name
        and "name" not in properties
        and any(k in arguments for k in _ENVELOPES)
    ):
        arguments = {k: v for k, v in arguments.items() if k != "name"}
    if len(arguments) != 1:
        return arguments
    (key, value), = arguments.items()
    if key not in _ENVELOPES or key in properties:
        return arguments
    inner, unreadable = decode_arguments(value) if isinstance(value, (dict, str)) else ({}, None)
    return inner if inner and unreadable is None else arguments


def _rename(arguments: dict, schema: dict, notes: list[str]) -> dict:
    properties = schema.get("properties") or {}
    if not isinstance(properties, dict) or not properties:
        return arguments
    unknown = [k for k in arguments if k not in properties]
    if not unknown:
        return arguments
    # Only onto a declared name the model did not also give: if both `query`
    # and `Query` arrived, the second is something the skill may read itself.
    free = {_key(p): p for p in properties if p not in arguments}
    renamed = dict(arguments)
    for key in unknown:
        target = free.get(_key(key))
        if target is None:
            target = _closest(_key(key), free)
        if target is None:
            continue
        renamed[target] = renamed.pop(key)
        free.pop(_key(target), None)
        notes.append(f"argument {key!r} read as {target!r}")
    return renamed


def _coerce(arguments: dict, schema: dict) -> dict:
    properties = schema.get("properties") or {}
    if not isinstance(properties, dict):
        return arguments
    required = set(schema.get("required") or ())
    out: dict[str, Any] = {}
    for key, value in arguments.items():
        spec = properties.get(key)
        if value is None and key in properties and key not in required:
            continue  # the skill's default, which is what null meant
        out[key] = _coerce_value(value, spec) if isinstance(spec, dict) else value
    return out


def _coerce_value(value, spec: dict):
    kinds = spec.get("type")
    kinds = [kinds] if isinstance(kinds, str) else list(kinds or ())
    if not kinds or _fits(value, kinds):
        return _fix_enum(value, spec)
    for kind in kinds:
        converted = _convert(value, kind, spec)
        if converted is not _MISS:
            return _fix_enum(converted, spec)
    return value


_MISS = object()


def _fits(value, kinds: list[str]) -> bool:
    for kind in kinds:
        if kind == "string" and isinstance(value, str):
            return True
        if kind == "boolean" and isinstance(value, bool):
            return True
        if kind == "integer" and isinstance(value, int) and not isinstance(value, bool):
            return True
        if kind == "number" and isinstance(value, (int, float)) and not isinstance(value, bool):
            return True
        if kind == "array" and isinstance(value, list):
            return True
        if kind == "object" and isinstance(value, dict):
            return True
        if kind == "null" and value is None:
            return True
    return False


def _convert(value, kind: str, spec: dict):
    if kind in ("integer", "number"):
        if isinstance(value, str):
            text = value.strip().replace(",", "")
            try:
                number = float(text)
            except ValueError:
                return _MISS
        elif isinstance(value, float) and kind == "integer":
            number = value
        else:
            return _MISS
        if kind == "integer":
            return int(number) if number.is_integer() else _MISS
        return int(number) if number.is_integer() and "." not in str(value) else number
    if kind == "boolean" and isinstance(value, (str, int)) and not isinstance(value, bool):
        lowered = str(value).strip().lower()
        if lowered in ("true", "1", "yes", "on"):
            return True
        if lowered in ("false", "0", "no", "off"):
            return False
        return _MISS
    if kind in ("array", "object") and isinstance(value, str):
        parsed = _parse_wrapped(value)
        if kind == "array" and isinstance(parsed, list):
            return parsed
        if kind == "object" and isinstance(parsed, dict):
            return parsed
        if kind == "object" or not value.strip():
            return _MISS
    if kind == "array" and value is not None and not isinstance(value, (list, dict)):
        # One item where a list of them was asked for.
        items = spec.get("items")
        return [_coerce_value(value, items) if isinstance(items, dict) else value]
    if kind == "string" and isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    return _MISS


def _fix_enum(value, spec: dict):
    allowed = spec.get("enum")
    if not isinstance(allowed, list) or not isinstance(value, str) or value in allowed:
        return value
    for option in allowed:
        if isinstance(option, str) and _key(option) == _key(value):
            return option
    return value
