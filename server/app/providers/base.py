"""The seam between orchestration and whatever is generating tokens.

Everything upstream of this module talks in `Message` and `Chunk` and never
learns which backend answered. Retrofitting that later means touching every
call site, so it exists before the first line of business logic.
"""

from __future__ import annotations

import ast
import base64
import json
import re
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable


@dataclass(frozen=True)
class Image:
    """An image riding along with a message.

    Raw bytes, not base64: every backend wants a different encoding, and this
    way the choice is made once per provider instead of guessed here.
    """

    name: str
    mime: str
    data: bytes

    def b64(self) -> str:
        return base64.b64encode(self.data).decode("ascii")


@dataclass(frozen=True)
class ToolCall:
    """A model asking for a skill, normalised across backends.

    `id` is the only thing that pairs a call with its result. Anthropic issues
    one; Ollama does not, so the provider mints it on the way up. Nothing above
    this module may read meaning into it beyond "these two go together".

    `arguments` is already decoded to a dict. Ollama sends a JSON object and
    Anthropic sends a dict, but a model under load will occasionally emit a
    JSON *string* instead -- normalising that is the provider's job, so callers
    never have to guess which they got.

    Named ToolCall rather than SkillCall deliberately: this is the vocabulary
    of the model APIs underneath, and the boundary where the app's word for it
    becomes theirs should be visible.
    """

    id: str
    name: str
    arguments: dict[str, Any]
    # The argument text as the model wrote it, set only when even a lenient
    # reading could not make an object of it. `arguments` is then empty, and
    # the turn loop tells the model its call did not parse rather than running
    # the skill with nothing.
    unreadable: str | None = None


def decode_arguments(raw: Any) -> tuple[dict[str, Any], str | None]:
    """A call's arguments as a dict, and the raw text when they would not decode.

    Strict JSON first. Then the mistakes models actually make, each of which
    has one obvious meaning: raw newlines and tabs inside a string (an HTML
    document, nearly always), a code fence around the object, prose before or
    after it, a trailing comma, a stray empty key, and Python's spelling of a
    dict. A value cut off part way is *not* repaired -- finishing it would run
    the skill with half a document as though it were the whole one.
    """
    if isinstance(raw, dict):
        return raw, None
    if raw is None or raw == "":
        return {}, None
    if not isinstance(raw, str):
        return {}, str(raw)
    for candidate in _readings(raw):
        for parse in (_json_loose, _python_literal):
            value = parse(candidate)
            if isinstance(value, dict):
                return value, None
    return {}, raw


def _readings(raw: str):
    text = raw.strip()
    yield text
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
        text = text.rsplit("```", 1)[0].strip()
        yield text
    start, end = text.find("{"), text.rfind("}")
    if start > 0 or (end != -1 and end < len(text) - 1):
        if start != -1 and end > start:
            text = text[start : end + 1]
            yield text
    # `,}` and `,]`, and the `,""}` an empty trailing key leaves behind.
    tidied = re.sub(r',\s*""\s*(?=[}\]])', "", text)
    tidied = re.sub(r",\s*(?=[}\]])", "", tidied)
    if tidied != text:
        yield tidied


def _json_loose(text: str):
    try:
        # strict=False admits control characters inside strings, which is the
        # whole of the "long value with raw newlines" failure.
        return json.loads(text, strict=False)
    except (ValueError, RecursionError):
        return None


def _python_literal(text: str):
    try:
        return ast.literal_eval(text)
    except (ValueError, SyntaxError, TypeError, MemoryError, RecursionError):
        return None


@dataclass(frozen=True)
class Message:
    role: str  # system | user | assistant | tool
    content: str
    # Only images. Text files are folded into `content` upstream, because every
    # model can read text and only some can see -- so inlining is the one form
    # that always works.
    images: tuple[Image, ...] = ()
    # Set on an assistant turn that asked for skills. Empty on every other turn.
    tool_calls: tuple[ToolCall, ...] = ()
    # Set on a role="tool" turn, naming the call it answers. Both are carried
    # because the backends pair results differently: Anthropic on the id,
    # Ollama on the name. Filling in one and not the other means the turn
    # replays correctly on one provider and silently mismatches on the other.
    tool_call_id: str | None = None
    tool_name: str | None = None


@dataclass(frozen=True)
class Chunk:
    """One streamed piece of a reply.

    `text` carries the delta. The final chunk of a stream sets `done` and, when
    the backend reports them, `prompt_tokens` / `completion_tokens`.
    """

    text: str = ""
    thinking: str = ""
    done: bool = False
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    # Populated on the final chunk when the model stopped to ask for skills.
    # It rides on `done` rather than arriving mid-stream because a caller can
    # only act on a turn's calls once the turn has stopped. A backend that
    # emits them earlier -- Ollama sends each on its own event -- buffers them
    # and hands the set over here.
    tool_calls: tuple[ToolCall, ...] = ()
    meta: dict[str, Any] = field(default_factory=dict)


class ProviderError(RuntimeError):
    """Backend failed in a way the caller may want to route around."""

    def __init__(self, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.retryable = retryable


class ContextOverflow(ProviderError):
    """Prompt did not fit. Retry once with a smaller window (section 7)."""

    def __init__(self, message: str) -> None:
        super().__init__(message, retryable=True)


class MalformedToolCall(ProviderError):
    """The model emitted a tool call the backend could not parse.

    Not the backend's fault and not ours: the model wrote something that is
    nearly JSON. Small local models do this when an argument is long and full
    of quotes and newlines -- an HTML document being the usual way to trip it.

    Its own class because the recovery is specific and cheap. The turn is not
    lost: the model is told its call did not parse and gets another round to
    send it again, the way a person would say "that came through garbled".
    """

    def __init__(self, message: str) -> None:
        super().__init__(message, retryable=True)


@runtime_checkable
class ModelProvider(Protocol):
    name: str
    model: str

    def stream(
        self,
        messages: Sequence[Message],
        *,
        think: str | None = None,
        tools: Sequence[dict] | None = None,
    ) -> AsyncIterator[Chunk]: ...

    async def embed(self, texts: Sequence[str]) -> list[list[float]]: ...

    async def health(self) -> bool: ...
