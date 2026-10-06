"""Group chats: a conversation with two or more agents in it.

The user sends one message and one or more members answer it, each as a turn
of its own run as that agent -- its instructions, its skills -- one after the
other in the same stream. Who answers is decided here, from the message:

* the members it @-mentions, in the order they are mentioned;
* everyone, for @everyone (or @all);
* otherwise whoever answered last, so a back-and-forth with one member stays
  with them -- and the first member when nobody has answered yet.

One answerer by default rather than all of them: Bom is built for small local
models, where every extra answer is another full turn of waiting, and in a
messenger's group you address the person you want an answer from.

Each member hears the others the way it hears the user: their answers reach it
as user messages that open with their name (`as_heard_by`). Replayed as its
own assistant turns they would be words put in its mouth, and a model asked to
continue from them answers as whoever spoke last.
"""

from __future__ import annotations

import dataclasses
import re

from .store import StoredMessage

#: An entry in an agent's skill list that stands for every connector's tools
#: (the MCP servers), whatever they are called and whenever they are added.
CONNECTORS = "@connectors"

#: How many agents a group can hold. Each one answering is a whole turn, so a
#: bigger room is a slower one; this is where that stops being a chat.
MAX_MEMBERS = 8

_EVERYONE = re.compile(r"(?<![\w@])@(everyone|all)\b", re.IGNORECASE)


def mentioned(text: str, members: list[str], names: dict[str, str]) -> list[str]:
    """The members `text` @-mentions, in the order it mentions them.

    A name is matched whole and without regard to case, so "@Research team"
    finds an agent called "Research team" and "@Researcher" does not find one
    called "Research". Longer names are tried first, which settles the case of
    one member's name being the start of another's.
    """
    if not text or "@" not in text:
        return []
    if _EVERYONE.search(text):
        return list(members)
    found: list[tuple[int, str]] = []
    taken: list[tuple[int, int]] = []
    for agent_id in sorted(members, key=lambda a: -len(names.get(a, ""))):
        name = names.get(agent_id, "").strip()
        if not name:
            continue
        pattern = re.compile(r"(?<![\w@])@" + re.escape(name) + r"(?![\w])", re.IGNORECASE)
        for match in pattern.finditer(text):
            span = match.span()
            if any(start < span[1] and span[0] < end for start, end in taken):
                continue
            taken.append(span)
            found.append((span[0], agent_id))
            break
    return [agent_id for _, agent_id in sorted(found)]


def speakers(
    text: str,
    members: list[str],
    names: dict[str, str],
    *,
    last: str | None = None,
    reply_as: str | None = None,
) -> list[str]:
    """Who answers this message, in the order they answer."""
    if not members:
        return []
    named = mentioned(text, members, names)
    if named:
        return named
    if reply_as in members:
        return [reply_as]
    if last in members:
        return [last]
    return [members[0]]


def as_heard_by(
    history: list[StoredMessage],
    authors: dict[str, str],
    speaker: str,
    names: dict[str, str],
) -> list[StoredMessage]:
    """The conversation as `speaker` hears it.

    One message in, one message out, in the same order -- compaction keeps an
    index into this list, and a merge would move it. An empty answer (a turn
    that failed before it said anything) is left as it is.
    """
    heard: list[StoredMessage] = []
    for message in history:
        author = authors.get(message.id)
        if message.role != "assistant" or author == speaker or not message.content.strip():
            heard.append(message)
            continue
        name = names.get(author, "Bom") if author else "Bom"
        heard.append(
            dataclasses.replace(
                message,
                role="user",
                content=f"[{name}]\n{message.content.strip()}",
                # Their working is theirs: what they called and thought is not
                # replayed to the next member, only what they said.
                reasoning=None,
                skills=None,
            )
        )
    return heard


def preamble(name: str, others: list[str]) -> str:
    """What a member is told about the room it is answering in."""
    if len(others) == 1:
        room = f"you and {others[0]}"
    else:
        room = "you, " + ", ".join(others[:-1]) + f" and {others[-1]}"
    return (
        f"This is a group chat between the user and Bom's agents: {room}. "
        "A message from another agent reaches you as a user message that opens "
        "with its name in square brackets. Speak only as "
        f"{name}: answer the part that is yours, build on what the others said "
        "instead of repeating it, and never write a reply for anyone else. Keep "
        "it short -- the user can ask for more."
    )
