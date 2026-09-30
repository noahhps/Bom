"""Cloud fallback. Only reached when the local model is unreachable.

Section 7: the fallback is what makes the tool trustworthy enough to use daily.
It is never used silently -- the orchestrator records which provider answered
and the client shows it.

The `anthropic` package is imported lazily so a purely local install doesn't
need it. Set ANTHROPIC_API_KEY (or run `ant auth login`) to enable this path.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator, Sequence
from typing import Any

from .base import Chunk, ContextOverflow, Message, ProviderError, ToolCall

# Fallback answers should arrive quickly; keep the reasoning budget modest.
_EFFORT = os.environ.get("ANTHROPIC_EFFORT", "medium")


class AnthropicProvider:
    def __init__(
        self,
        model: str = "claude-opus-5",
        max_tokens: int = 64_000,
        *,
        context_tokens: int = 200_000,
    ) -> None:
        self.name = "anthropic"
        self.model = model
        # Generous because the reply is streamed: a large cap costs nothing
        # until it is used, and a whole page arriving as one tool call used to
        # be cut off at 8k tokens.
        self.max_tokens = max_tokens
        self.context_tokens = context_tokens
        # How long the prompt prefix stays cached between requests: "5m" or
        # "1h". Set from settings by the router (Enterprise mode holds it for
        # the hour).
        self.cache_ttl = "5m"
        # Each model's input window and output cap, from the Models API. Only
        # answers are kept, so a failed lookup is tried again on the next turn.
        self._windows: dict[str, int] = {}
        self._outputs: dict[str, int] = {}
        self._client = None

    async def context_window(self) -> int:
        """The window budget: the configured one, or the model's when smaller.

        The Models API reports `max_input_tokens` per model, which is what
        tells a 200k Haiku from a 1M Opus without a table kept here -- and
        `max_tokens`, the longest reply the model may write, which caps the
        reply below so a large configured cap is not a 400 on a smaller model.
        """
        window = self._windows.get(self.model)
        if window is None:
            try:
                client = self._ensure_client()
                entry = await client.models.retrieve(self.model)
                window = int(getattr(entry, "max_input_tokens", 0) or 0)
                output = int(getattr(entry, "max_tokens", 0) or 0)
            except Exception:  # noqa: BLE001 -- the configured budget stands
                window, output = 0, 0
            if window:
                self._windows[self.model] = window
            if output:
                self._outputs[self.model] = output
        return min(self.context_tokens, window) if window else self.context_tokens

    def _reply_cap(self) -> int:
        output = self._outputs.get(self.model)
        return min(self.max_tokens, output) if output else self.max_tokens

    def _cache_control(self) -> dict:
        control: dict = {"type": "ephemeral"}
        if self.cache_ttl and self.cache_ttl != "5m":
            control["ttl"] = self.cache_ttl
        return control

    async def sees_images(self) -> bool:
        return True  # every current Claude model takes images

    def _ensure_client(self):
        if self._client is None:
            try:
                from anthropic import AsyncAnthropic
            except ImportError as exc:  # pragma: no cover - depends on install
                raise ProviderError(
                    "cloud fallback requires `pip install anthropic`"
                ) from exc
            self._client = AsyncAnthropic()
        return self._client

    async def stream(
        self,
        messages: Sequence[Message],
        *,
        tools: Sequence[dict] | None = None,
        think: str | None = None,
    ) -> AsyncIterator[Chunk]:
        client = self._ensure_client()

        # Anthropic takes the system prompt as its own parameter
        system = "\n\n".join(m.content for m in messages if m.role == "system")
        turns = _build_turns(messages)

        request: dict = {
            "model": self.model,
            "max_tokens": self._reply_cap(),
            "messages": turns,
            "output_config": {"effort": think or _EFFORT},
            # Prompt caching. Nothing is cached without a breakpoint, and
            # every round of a tool loop resends the whole conversation -- so
            # without these, a twenty-round turn paid full price for the same
            # prefix twenty times. Two breakpoints: the system prompt (with the
            # tools ahead of it, the part that holds for the whole
            # conversation), and the top-level one, which the API places on
            # the last block and so moves forward each round to cover
            # everything the previous round already sent.
            "extra_body": {"cache_control": self._cache_control()},
        }
        if system:
            request["system"] = [
                {"type": "text", "text": system, "cache_control": self._cache_control()}
            ]
        if tools:
            request["tools"] = [
                {
                    "name": t["name"],
                    "description": t.get("description", ""),
                    "input_schema": t.get("parameters")
                    or {"type": "object", "properties": {}},
                }
                for t in tools
            ]

        try:
            async with client.messages.stream(**request) as stream:
                async for text in stream.text_stream:
                    yield Chunk(text=text)
                final = await stream.get_final_message()

            if final.stop_reason == "refusal":
                raise ProviderError("cloud model declined the request")

            tool_calls: list[ToolCall] = []
            for block in getattr(final, "content", []):
                if getattr(block, "type", "") == "tool_use":
                    tool_calls.append(
                        ToolCall(
                            id=str(block.id),
                            name=str(block.name),
                            arguments=dict(getattr(block, "input", {}) or {}),
                        )
                    )

            usage = final.usage
            cache_read = int(getattr(usage, "cache_read_input_tokens", 0) or 0) if usage else 0
            cache_write = int(getattr(usage, "cache_creation_input_tokens", 0) or 0) if usage else 0
            yield Chunk(
                text="",
                done=True,
                tool_calls=tuple(tool_calls),
                # The whole prompt: `input_tokens` counts only what was neither
                # read from the cache nor written to it.
                prompt_tokens=(usage.input_tokens + cache_read + cache_write) if usage else None,
                completion_tokens=usage.output_tokens if usage else None,
                meta={
                    key: value
                    for key, value in (
                        ("cache_read_tokens", cache_read),
                        ("cache_write_tokens", cache_write),
                    )
                    if value
                },
            )
        except ProviderError:
            raise
        except Exception as exc:
            raise _translate_error(exc) from exc

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        raise ProviderError("no embedding model on the cloud fallback path")

    async def list_models(self) -> list[dict]:
        """Claude models, from Anthropic rather than from a list kept here.

        A hard-coded table would be wrong within a release: models are added
        and retired on Anthropic's schedule, not this repository's. The API
        answers the question, so it is asked -- and an install without the
        package, or without a key, comes back empty rather than raising, since
        "nothing to choose from" is exactly what the picker should show there.
        """
        try:
            client = self._ensure_client()
        except ProviderError:
            return []
        try:
            listing = await client.models.list(limit=100)
        except Exception:  # noqa: BLE001 -- an empty picker, not a failed page
            return []
        return [
            {
                "id": str(entry.id),
                "name": str(getattr(entry, "display_name", "") or entry.id),
                "description": "",
                "context": None,
                # Every current Claude model sees, calls tools and reasons; the
                # per-model flags exist for OpenRouter, where they vary.
                "vision": True,
                "tools": True,
                "reasoning": True,
                "free": False,
            }
            for entry in getattr(listing, "data", []) or []
        ]

    async def health(self) -> bool:
        try:
            self._ensure_client()
        except ProviderError:
            return False
        return bool(
            os.environ.get("ANTHROPIC_API_KEY")
            or os.environ.get("ANTHROPIC_AUTH_TOKEN")
            or (os.path.expanduser("~/.config/anthropic") and _profile_exists())
        )


def _profile_exists() -> bool:
    from pathlib import Path

    return (Path.home() / ".config" / "anthropic" / "credentials").exists()


def _translate_error(exc: Exception) -> ProviderError:
    name = type(exc).__name__
    text = str(exc)
    if "prompt is too long" in text or "context" in text.lower():
        return ContextOverflow(text)
    retryable = name in ("RateLimitError", "APIConnectionError", "InternalServerError")
    return ProviderError(f"{name}: {text[:500]}", retryable=retryable)


def _build_turns(messages: Sequence[Message]) -> list[dict[str, Any]]:
    """Build conversation turns formatted for the Anthropic Messages API."""
    turns: list[dict[str, Any]] = []

    for m in messages:
        if m.role == "system":
            continue

        if m.role == "tool":
            # Anthropic expects tool results as role="user" content blocks
            tool_result_block = {
                "type": "tool_result",
                "tool_use_id": m.tool_call_id or "call_0",
                "content": m.content,
            }
            if turns and turns[-1]["role"] == "user" and isinstance(turns[-1]["content"], list):
                turns[-1]["content"].append(tool_result_block)
            else:
                turns.append({"role": "user", "content": [tool_result_block]})

        elif m.role == "assistant":
            blocks: list[dict[str, Any]] = []
            if m.content:
                blocks.append({"type": "text", "text": m.content})
            for call in m.tool_calls:
                blocks.append(
                    {
                        "type": "tool_use",
                        "id": call.id,
                        "name": call.name,
                        "input": call.arguments,
                    }
                )
            turns.append({"role": "assistant", "content": blocks or m.content})

        elif m.role == "user":
            content = _content(m)
            # Straight after tool results -- a render handed back to look at
            # -- the picture joins the results' turn rather than opening a
            # second user turn of its own.
            if (
                m.images
                and turns
                and turns[-1]["role"] == "user"
                and isinstance(turns[-1]["content"], list)
            ):
                turns[-1]["content"].extend(content if isinstance(content, list) else [
                    {"type": "text", "text": content}
                ])
            else:
                turns.append({"role": "user", "content": content})

    return turns


def _content(message: Message):
    if not message.images:
        return message.content

    blocks: list[dict] = [
        {
            "type": "image",
            "source": {"type": "base64", "media_type": image.mime, "data": image.b64()},
        }
        for image in message.images
    ]
    if message.content:
        blocks.append({"type": "text", "text": message.content})
    return blocks
