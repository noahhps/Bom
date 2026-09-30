"""Compaction: a long conversation keeps going instead of forgetting its start.

Without this, a conversation that outgrew its window was trimmed from the
head, one message at a time, every turn. Two things were wrong with that. The
model silently lost the beginning -- usually where the user said what they
wanted -- and the start of the prompt changed on every turn, which is the one
change that throws away everything a backend had cached behind it.

Compaction does it in steps instead. When the history a turn would replay
fills COMPACT_AT of the window, the older turns are summarised by the same
model into one note, stored, and replayed from then on in their place, ahead
of the recent turns that are still sent word for word. The next compaction
folds the previous summary and the turns since into a new one. Between
compactions the start of the prompt does not move, so it stays cached.

Two thresholds, set by Enterprise mode (see enterprise.py): an ordinary
install compacts at half the window and keeps a quarter of it verbatim,
because a local model's window is small and a summary of the rest is cheap;
Enterprise mode waits until the window is nearly full and keeps more, with a
longer, more exact summary, because there the window is large and detail is
what the conversation is for.

Within one turn, a long run of tool calls is kept in bounds separately: see
`clear_old_results`, which replaces the results of earlier rounds with a line
saying what they were once the turn's own window nears its limit.
"""

from __future__ import annotations

import dataclasses
import json
from collections.abc import Callable, Sequence

from .providers import Message, ProviderError, ToolCall

#: How the summary is introduced where the folded turns used to be.
SUMMARY_OPEN = (
    "[Summary of the earlier part of this conversation. The older messages were "
    "compacted to save context; this stands in for them.]"
)
SUMMARY_CLOSE = "[End of summary. The conversation continues below.]"

SUMMARY_SYSTEM = (
    "You compact long conversations. You are given the earlier part of a "
    "conversation between a user and an AI assistant, and you write the summary "
    "that will replace it. The assistant carrying on will see only your summary "
    "and the most recent messages, so anything you leave out is gone for good.\n\n"
    "Keep, under these headings:\n"
    "- Goals: what the user asked for, in order, and which requests are done or "
    "still open.\n"
    "- Decisions and preferences: what was agreed, and any constraint or "
    "preference the user stated.\n"
    "- Facts: names, numbers, file paths, commands, identifiers, URLs, error "
    "messages and their causes -- copied exactly, never paraphrased.\n"
    "- Work done: what was read, written, changed or run with tools, and the "
    "results that still matter.\n"
    "- Where it stands: the current state and the next step.\n\n"
    "Write dense plain text or short bullets. Do not address the user, do not "
    "comment on the conversation, and do not add anything the transcript does "
    "not say."
)

#: A tool result from an earlier round, once the turn's window runs short.
CLEARED = (
    "[Cleared to save context: this {name} result ({size} characters) was read "
    "earlier in this turn. It began: {head} -- call {name} again if you need "
    "the rest.]"
)

#: The most of the history's room a summary may take. Below the gap between
#: COMPACT_AT and COMPACT_KEEP in both profiles (0.25 and 0.45), so a
#: compacted history always lands under the threshold it was compacted at.
SUMMARY_SHARE = 0.15

#: Tool-call arguments longer than this are shortened when a turn is cleared:
#: a whole file sent to code_write or a page to write_canvas has already been
#: applied, and replaying it every round is the largest cost a long turn has.
LONG_ARGUMENT = 2_000


def summary_block(summary: str) -> str:
    return f"{SUMMARY_OPEN}\n\n{summary.strip()}\n\n{SUMMARY_CLOSE}"


def plan_split(costs: Sequence[int], roles: Sequence[str], keep_tokens: int) -> int | None:
    """Where the verbatim tail starts, or None when nothing can be folded.

    The tail is the newest messages that fit in `keep_tokens`, and always
    starts on a user message -- a turn is folded or kept whole, never split
    between the question and its answer. The newest user message (the one
    being answered) is always kept, even alone over the allowance.
    """
    if not costs:
        return None
    users = [i for i, role in enumerate(roles) if role == "user"]
    if not users:
        return None
    last_user = users[-1]
    used = 0
    start = len(costs)
    for index in range(len(costs) - 1, -1, -1):
        if used + costs[index] > keep_tokens and index < last_user:
            break
        used += costs[index]
        start = index
    # Forward to a user message, so the kept part opens a turn.
    while start < len(roles) and roles[start] != "user":
        start += 1
    start = min(start, last_user)
    return start if start > 0 else None


def transcript(messages: Sequence, recap: Callable[[object], str], limit: int) -> str:
    """The folded messages as plain text for the summariser, newest kept when
    it has to be cut (the start is what an older summary already covers)."""
    parts: list[str] = []
    for message in messages:
        who = "User" if message.role == "user" else "Assistant"
        text = (message.content or "").strip()
        working = recap(message)
        body = "\n\n".join(p for p in (text, working) if p)
        if body:
            parts.append(f"{who}:\n{body}")
    joined = "\n\n---\n\n".join(parts)
    if limit > 0 and len(joined) > limit:
        joined = "…[earlier part cut]\n\n" + joined[-limit:]
    return joined


async def summarize(
    provider,
    previous: str | None,
    folded: str,
    *,
    target_tokens: int,
) -> str:
    """One summary covering `previous` (an earlier summary) and `folded`.

    Raises ProviderError when the model gives back nothing usable, so the
    caller can fall back to replaying the history as it is.
    """
    words = max(60, int(target_tokens * 0.75))
    ask = [f"Write the summary in about {words} words or fewer."]
    if previous:
        ask.append(
            "An earlier summary already covers the start of the conversation. "
            "Fold it and the transcript after it into one updated summary.\n\n"
            f"Earlier summary:\n{previous.strip()}"
        )
    ask.append(f"Transcript to summarise:\n\n{folded}")
    prompt = [
        Message(role="system", content=SUMMARY_SYSTEM),
        Message(role="user", content="\n\n".join(ask)),
    ]
    written: list[str] = []
    async for chunk in provider.stream(prompt):
        if chunk.text:
            written.append(chunk.text)
    summary = "".join(written).strip()
    if not summary:
        raise ProviderError("the model wrote an empty summary")
    # A model that ignores the length is cut rather than trusted: the summary
    # rides in every later request.
    cap = max(600, target_tokens * 5)
    if len(summary) > cap:
        summary = summary[:cap].rstrip() + "…"
    return summary


def _shorten_arguments(arguments: dict) -> dict:
    shortened = {}
    for key, value in arguments.items():
        if isinstance(value, str) and len(value) > LONG_ARGUMENT:
            shortened[key] = (
                value[:400] + f"\n…[{len(value) - 400} more characters, already sent]"
            )
        elif isinstance(value, (list, dict)):
            dumped = json.dumps(value, ensure_ascii=False)
            if len(dumped) > LONG_ARGUMENT:
                shortened[key] = dumped[:400] + f"…[{len(dumped) - 400} more characters, already sent]"
            else:
                shortened[key] = value
        else:
            shortened[key] = value
    return shortened


def clear_old_results(window: list[Message], anchor: int) -> tuple[list[Message], int]:
    """The window with every tool result before the latest round cleared.

    Only messages from `anchor` (the turn's own user message) onwards are
    touched: the history before it is already compacted text. The latest
    round -- the last assistant message that asked for tools, and the results
    after it -- is left whole, since that is what the model is working on.
    Each call keeps its result, so every backend still sees a result for every
    call it made.

    Returns the new window and how many results were cleared.
    """
    last_ask = None
    for index in range(len(window) - 1, anchor - 1, -1):
        if window[index].role == "assistant" and window[index].tool_calls:
            last_ask = index
            break
    if last_ask is None:
        return window, 0

    cleared = 0
    out = list(window)
    for index in range(anchor + 1, last_ask):
        message = out[index]
        if message.role == "tool" and not message.content.startswith("[Cleared to save context"):
            text = message.content or ""
            head = " ".join(text.split())[:160] or "(empty)"
            name = message.tool_name or "the tool"
            out[index] = dataclasses.replace(
                message, content=CLEARED.format(name=name, size=len(text), head=head)
            )
            cleared += 1
        elif message.role == "assistant" and message.tool_calls:
            calls = tuple(
                ToolCall(id=call.id, name=call.name, arguments=_shorten_arguments(call.arguments or {}))
                for call in message.tool_calls
            )
            out[index] = dataclasses.replace(message, tool_calls=calls)
        elif message.role == "user" and message.images:
            # A picture handed back for one round has been looked at.
            out[index] = dataclasses.replace(
                message, images=(), content=message.content + " [picture no longer attached]"
            )
    return out, cleared
