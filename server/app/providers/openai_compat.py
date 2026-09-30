"""Any backend that speaks OpenAI's chat-completions API.

Most of the model world does: OpenAI itself, Google's Gemini (through its
OpenAI-compatible endpoint), xAI, Mistral, DeepSeek, Groq, Cerebras, Together,
Fireworks, Azure OpenAI -- and the servers people run themselves, LM Studio,
vLLM, llama.cpp, Jan. One class answers for all of them. What differs between
them is data, kept in `presets.py`: where they live, whether they need a key,
how they spell reasoning, what they will not accept.

The encoding is OpenRouter's (`openrouter._encode` and friends): OpenRouter
speaks this same format, so the message and tool-call shapes are shared rather
than written twice.

Services agree on the core and disagree at the edges, so the edges are
handled where they show up rather than guessed at in advance:

* **reasoning** arrives as `reasoning_content` (DeepSeek, xAI, vLLM, LM
  Studio) or `reasoning` (Groq and the servers that copy OpenRouter) -- both
  are read;
* **optional parameters** -- `reasoning_effort`, `stream_options` -- are
  refused by some services and some models. A 400 that names one is answered
  by sending the request again without it, and the model is remembered, so
  the second turn does not pay for the first one's discovery;
* **cached prompt tokens** are reported as OpenAI's
  `prompt_tokens_details.cached_tokens` or DeepSeek's `prompt_cache_hit_tokens`.
  Every one of these services caches a repeated prefix on its own; nothing
  has to be marked.

Like the other cloud backends it does not embed: recall is indexed locally.
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator, Sequence
from typing import Any

import httpx

from .base import Chunk, ContextOverflow, Message, ProviderError
from .openrouter import _encode, _finish_calls, _merge_call

_TIMEOUT = httpx.Timeout(connect=5.0, read=300.0, write=30.0, pool=5.0)
_CATALOGUE_TTL_SECONDS = 600.0

_EFFORTS = frozenset(("low", "medium", "high"))

#: Parameters a request may go without. When a service refuses one, it is
#: dropped and the request sent again.
_OPTIONAL = ("reasoning_effort", "stream_options", "parallel_tool_calls")

#: Model ids that are not chat models, kept out of the picker: OpenAI's
#: listing is mostly these.
_NOT_CHAT = (
    "embed", "embedding", "whisper", "tts", "dall-e", "moderation", "davinci",
    "babbage", "transcribe", "realtime", "audio", "image", "sora", "rerank",
    "search-preview", "computer-use", "-ocr", "guard",
)


class OpenAICompatProvider:
    """One configured connection: a service, an address, a key and a model."""

    #: How the HTTP client is made; a hook so tests can stand a service up in
    #: memory for every connection the app creates.
    client_factory = None

    def __init__(
        self,
        *,
        connection_id: str,
        name: str,
        label: str,
        base_url: str,
        api_key: str = "",
        model: str = "",
        preset: dict | None = None,
        context_tokens: int = 128_000,
    ) -> None:
        preset = preset or {}
        # What a message is stored with ("groq", "openai", "lmstudio") and
        # what the picker shows ("Groq", or whatever the reader named it).
        self.name = name
        self.label = label
        self.connection_id = connection_id
        self.preset = preset
        self.base_url = (base_url or "").rstrip("/")
        self.api_key = (api_key or "").strip()
        self.model = model or ""
        self.context_tokens = context_tokens
        # Set by the router alongside the other cloud backends; nothing here
        # needs marking, but the attribute keeps apply_limits uniform.
        self.cache_ttl = "5m"
        self.kind = preset.get("kind", "cloud")
        self._client = (
            self.client_factory() if self.client_factory else httpx.AsyncClient(timeout=_TIMEOUT)
        )
        self._catalogue: list[dict] = []
        self._catalogue_at = 0.0
        # Per model, the optional parameters it has refused.
        self._refused: dict[str, set[str]] = {}

    # -- credentials ------------------------------------------------------

    @property
    def needs_key(self) -> bool:
        return bool(self.preset.get("key_required", self.kind == "cloud"))

    @property
    def configured(self) -> bool:
        return bool(self.base_url) and (bool(self.api_key) or not self.needs_key)

    def _headers(self) -> dict[str, str]:
        headers = {"Accept": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
            # Azure's own header, beside the bearer its v1 API also takes.
            extra = self.preset.get("key_header")
            if extra:
                headers[extra] = self.api_key
        return headers

    def _url(self, path: str) -> str:
        return f"{self.base_url}/{path.lstrip('/')}"

    # -- generation -------------------------------------------------------

    def _payload(self, messages: Sequence[Message], think: Any, tools) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": [_encode(m) for m in messages],
            "stream": True,
        }
        if self.preset.get("usage_option", True):
            payload["stream_options"] = {"include_usage": True}
        if tools and self.preset.get("tools", True):
            payload["tools"] = [{"type": "function", "function": t} for t in tools]
        effort = _effort(think)
        if effort and self.preset.get("reasoning") == "effort":
            payload["reasoning_effort"] = effort
        for name in self._refused.get(self.model, ()):
            payload.pop(name, None)
        return payload

    async def stream(
        self,
        messages: Sequence[Message],
        *,
        think: Any = None,
        tools: Sequence[dict] | None = None,
    ) -> AsyncIterator[Chunk]:
        if not self.configured:
            raise ProviderError(f"{self.label} is not connected: add its key in Settings > Models")
        if not self.model:
            raise ProviderError(f"Pick a model for {self.label} in Settings > Models")
        payload = self._payload(messages, think, tools)
        # At most one retry per optional parameter: each refusal takes one out.
        for _ in range(len(_OPTIONAL) + 1):
            try:
                async for chunk in self._stream_once(payload):
                    yield chunk
                return
            except _Refused as refused:
                self._refused.setdefault(self.model, set()).add(refused.parameter)
                payload.pop(refused.parameter, None)
        raise ProviderError(f"{self.label} kept refusing the request")

    async def _stream_once(self, payload: dict[str, Any]) -> AsyncIterator[Chunk]:
        pending: dict[int, dict[str, Any]] = {}
        usage: dict[str, Any] = {}
        finish_reason = ""
        started = False
        try:
            async with self._client.stream(
                "POST", self._url("chat/completions"), json=payload, headers=self._headers()
            ) as response:
                if response.status_code >= 400:
                    body = (await response.aread()).decode("utf-8", "replace")
                    refused = _refused_parameter(response.status_code, body, payload)
                    if refused:
                        raise _Refused(refused)
                    raise _translate_error(self.label, response.status_code, body)

                async for line in response.aiter_lines():
                    if not line.strip() or line.startswith(":") or not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        event = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    if error := event.get("error"):
                        # An error after a 200: the upstream model refused
                        # something the service accepted.
                        detail = error if isinstance(error, dict) else {"message": str(error)}
                        code = str(detail.get("code") or "")
                        raise _translate_error(
                            self.label, int(code) if code.isdigit() else 500, json.dumps(detail)
                        )
                    if reported := event.get("usage"):
                        usage = reported
                    choices = event.get("choices") or []
                    if not choices:
                        continue
                    choice = choices[0]
                    finish_reason = choice.get("finish_reason") or finish_reason
                    delta = choice.get("delta") or {}
                    for entry in delta.get("tool_calls") or ():
                        _merge_call(pending, entry)
                    text = delta.get("content") or ""
                    thinking = (
                        delta.get("reasoning_content")
                        or delta.get("reasoning")
                        or delta.get("thinking")
                        or ""
                    )
                    if not isinstance(thinking, str):
                        thinking = ""
                    if text or thinking:
                        started = True
                        yield Chunk(text=text, thinking=thinking)
        except (ProviderError, _Refused):
            raise
        except httpx.HTTPError as exc:
            raise ProviderError(
                f"{self.label} unreachable: {exc}", retryable=not started
            ) from exc

        if finish_reason == "content_filter":
            raise ProviderError(f"{self.label} filtered this reply")
        details = usage.get("prompt_tokens_details") or {}
        cached = details.get("cached_tokens") or usage.get("prompt_cache_hit_tokens")
        yield Chunk(
            done=True,
            tool_calls=_finish_calls(pending),
            prompt_tokens=usage.get("prompt_tokens"),
            completion_tokens=usage.get("completion_tokens"),
            meta={"cache_read_tokens": cached} if cached else {},
        )

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        raise ProviderError(f"recall is indexed locally; {self.label} does not embed")

    # -- what the picker needs -------------------------------------------

    async def health(self) -> bool:
        """Answering, with the key it holds. The model listing is the one
        endpoint every one of these services has, and it checks the key."""
        if not self.configured:
            return False
        try:
            response = await self._client.get(
                self._url("models"), headers=self._headers(), timeout=httpx.Timeout(6.0)
            )
        except httpx.HTTPError:
            return False
        return response.status_code == 200

    async def list_models(self, *, refresh: bool = False) -> list[dict]:
        now = time.monotonic()
        if self._catalogue and not refresh and now - self._catalogue_at < _CATALOGUE_TTL_SECONDS:
            return self._catalogue
        if not self.configured:
            return []
        try:
            response = await self._client.get(self._url("models"), headers=self._headers())
        except httpx.HTTPError as exc:
            raise ProviderError(f"{self.label} unreachable: {exc}", retryable=True) from exc
        if response.status_code >= 400:
            raise _translate_error(self.label, response.status_code, response.text)
        try:
            body = response.json()
        except ValueError as exc:
            raise ProviderError(f"{self.label} did not list its models") from exc
        # {"data": [...]} is the standard; Together answers with the bare list.
        entries = body.get("data") if isinstance(body, dict) else body
        strip = self.preset.get("strip_model_prefix", "")
        models = []
        for entry in entries or ():
            if not isinstance(entry, dict) or not entry.get("id"):
                continue
            described = _describe(entry, strip)
            if described is not None:
                models.append(described)
        self._catalogue = sorted(models, key=lambda m: m["id"])
        self._catalogue_at = now
        return self._catalogue

    async def context_window(self) -> int:
        """The configured budget, or the model's own window where the listing
        says what it is (Groq, Together, Mistral and others do)."""
        try:
            listed = await self.list_models()
        except ProviderError:
            listed = self._catalogue
        known = next((m.get("context") for m in listed if m.get("id") == self.model), None)
        try:
            window = int(known or 0)
        except (TypeError, ValueError):
            window = 0
        fallback = int(self.preset.get("window") or 128_000)
        return min(self.context_tokens, window or fallback)

    async def sees_images(self) -> bool:
        """What the listing says about the model, else what the service's
        models generally do -- and never for a server run locally, whose model
        is unknown and would fail the turn on a picture it cannot read."""
        try:
            listed = await self.list_models()
        except ProviderError:
            listed = self._catalogue
        known = next((m for m in listed if m.get("id") == self.model), None)
        if known and known.get("vision") is not None:
            return bool(known["vision"])
        return bool(self.preset.get("vision", False))

    def set_api_key(self, key: str) -> None:
        self.api_key = (key or "").strip()
        self._catalogue = []
        self._catalogue_at = 0.0

    async def aclose(self) -> None:
        await self._client.aclose()


class _Refused(Exception):
    def __init__(self, parameter: str) -> None:
        super().__init__(parameter)
        self.parameter = parameter


def _effort(think: Any) -> str | None:
    if isinstance(think, bool) or think is None:
        return None
    if isinstance(think, int):
        return "low" if think <= 4096 else "medium" if think <= 16384 else "high"
    level = str(think).strip().lower()
    return level if level in _EFFORTS else None


def _refused_parameter(status: int, body: str, payload: dict[str, Any]) -> str | None:
    """The optional parameter a 400 is about, if it is about one we sent."""
    if status not in (400, 422):
        return None
    lowered = body.lower()
    for name in _OPTIONAL:
        if name in payload and name in lowered:
            return name
    # Some services say "reasoning is not supported" without the field name.
    if "reasoning_effort" in payload and "reasoning" in lowered and (
        "not supported" in lowered or "unsupported" in lowered or "unrecognized" in lowered
    ):
        return "reasoning_effort"
    return None


def _describe(entry: dict, strip: str = "") -> dict | None:
    model_id = str(entry["id"])
    if strip and model_id.startswith(strip):
        model_id = model_id[len(strip):]
    lowered = model_id.lower()
    if any(marker in lowered for marker in _NOT_CHAT):
        return None
    # Services that describe their models say so under different names.
    context = (
        entry.get("context_window")
        or entry.get("context_length")
        or entry.get("max_context_length")
        or entry.get("max_model_len")
        or (entry.get("top_provider") or {}).get("context_length")
    )
    capabilities = entry.get("capabilities") or {}
    vision = capabilities.get("vision") if isinstance(capabilities, dict) else None
    architecture = entry.get("architecture") or {}
    if vision is None and isinstance(architecture, dict) and architecture.get("input_modalities"):
        vision = "image" in architecture["input_modalities"]
    return {
        "id": model_id,
        "name": str(entry.get("display_name") or entry.get("name") or model_id),
        "description": str(entry.get("description") or "")[:280],
        "context": context,
        "vision": vision,
        "owner": entry.get("owned_by") or "",
    }


def _translate_error(label: str, status: int, body: str) -> ProviderError:
    lowered = body.lower()
    if status in (401, 403) and "moderation" not in lowered:
        return ProviderError(f"{label} rejected the key. Replace it in Settings > Models.")
    if status == 402 or "insufficient_quota" in lowered or (status == 429 and "credit" in lowered):
        return ProviderError(f"{label} says this account has no credit left.")
    if status == 429:
        return ProviderError(f"{label} is rate limiting this key", retryable=True)
    if "context" in lowered and ("length" in lowered or "maximum" in lowered or "too long" in lowered):
        return ContextOverflow(body)
    if status == 404 and "model" in lowered:
        return ProviderError(f"{label} has no model by that name any more. Pick another.")
    return ProviderError(f"{label} returned {status}: {body[:400]}", retryable=status >= 500)
