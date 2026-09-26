"""Turn orchestration -- section 6's request lifecycle.

    message arrives
      -> resolve session, append user message
      -> build system prompt (static preamble first, for cache stability)
      -> assemble window
      -> provider.stream()
      -> stream tokens to the client
      -> persist assistant message
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from datetime import datetime, timezone

from . import attachments as files
from .approvals import (
    ALLOW_ALWAYS,
    ALLOW_ONCE,
    ALLOW_SESSION,
    APPROVAL_DEFAULTS,
    Approvals,
    allowed,
    read_auto_approved,
    write_auto_approved,
)
from .choices import Choices
from .config import Settings, ThinkingLevel
from .memory import MEMORY_DEFAULTS
from .situation import Situation, render as render_situation
from .providers import (
    Chunk,
    ContextOverflow,
    Image,
    Message,
    MalformedToolCall,
    ProviderError,
    ProviderRouter,
)
from .design_mode import DESIGN, DESIGN_PREAMBLE
from .design_presets import tokens_for
from .skills.design import (
    NO_DESIGN,
    match as design_match,
    options as design_options,
    resolve as design_resolve,
)
from .skills.registry import Registry
from .store import Store, StoredAttachment, StoredMessage




def estimate_tokens(text: str) -> int:
    """Cheap proxy. Real counts come back from the provider and overwrite this."""
    return max(1, len(text) // 4)


# What one image costs the window. Real figures depend on the model and the
# resolution -- a few hundred tokens for a thumbnail, a couple of thousand for
# a screenshot. This sits at the high end deliberately: overcharging trims a
# turn early, undercharging overflows the context, and only one of those is
# recoverable.
IMAGE_TOKENS = 1600

# How many images travel with a request, newest first.
#
# Resending every picture in a long conversation is not just expensive: asked
# about the photo they just attached, a small vision model handed six images
# will answer about one of the others. Older pictures stay in the transcript as
# a named placeholder, so the model knows they existed and can be asked to look
# again by sending one afresh.
MAX_WINDOW_IMAGES = 4


# The fallback round cap, when settings does not carry one (a bare test double).
# The real limit is settings.max_tool_rounds -- a local model handed a shelf of
# skills will loop on near-identical calls, and this is what stops a bad turn
# from burning the whole context window.
MAX_TOOL_ROUNDS = 20

# How much of a past turn's working to carry into later turns, so the model
# keeps the thread's context -- what it looked up and what it concluded --
# rather than seeing only its own final wording. Prepended to every later turn,
# so kept short: it competes with the live conversation for the same budget.
CARRIED_RESULT_CHARS = 240      # per tool result, summarised to one line
CARRIED_REASONING_CHARS = 400   # the tail of the deliberation

# A skill's result is trimmed here rather than in build_window, because the
# window trims from the *head* -- so an unbounded result would push out the
# user's actual question rather than itself.
MAX_RESULT_CHARS = 4000


#: How many rounds a turn may lose to unparseable tool calls before it
#: gives up and reports the failure like any other.
MAX_GARBLED_ROUNDS = 2


class Orchestrator:
    def __init__(
        self,
        settings: Settings,
        store: Store,
        router: ProviderRouter,
        registry: Registry | None = None,
    ) -> None:
        self.settings = settings
        self.store = store
        self.router = router
        self.registry = registry
        # Approval prompts in flight, and the skills a conversation has already
        # said yes to. Both in memory: a prompt belongs to an open stream, and
        # a session grant is scoped to a conversation the reader is still in.
        self.approvals = Approvals()
        # Questions the turn stops to ask where the answer is a pick rather
        # than a yes -- which design standard to follow. Same lifetime as the
        # approvals beside it, and for the same reason.
        self.choices = Choices()
        self._session_grants: dict[str, set[str]] = {}

    def _skill_schemas(self, allowed: set[str] | None = None) -> list[dict] | None:
        """What the model is told it can call, or None when it can call nothing.

        `enabled()` rather than `all()`: a skill switched off is still listed on
        the Skills page but must not be offered here. None rather than an empty
        list, because an empty `tools` array still trips the chat template's
        tool branch and tells the model it has a shelf with nothing on it.

        `allowed` narrows that to an agent's subset: None means "every enabled
        skill" (no agent, or an agent that named none to restrict), and a set --
        even an empty one -- means only those. An empty set therefore collapses
        to None below, which is correct: an agent given no skills is offered no
        tools at all.
        """
        if self.registry is None:
            return None
        schemas = [
            skill.schema()
            for name, skill in self.registry.enabled()
            if allowed is None or name in allowed
        ]
        return schemas or None

    # -- prompt assembly --------------------------------------------------

    def build_system_prompt(self, session_id: str | None = None) -> tuple[str, list[str]]:
        """The preamble, then where the user is, then whatever is remembered.

        Returns (prompt, fact ids).

        Three sections, ordered by how often each changes, because everything
        after the first edit is cache that has to be paid for again:

        * the preamble never changes;
        * the situation is captured once when the conversation starts and is
          fixed for its lifetime;
        * facts can be rewritten by the curation pass after *any* turn.

        So facts stay last. Putting the situation after them would throw away
        the situation's cache every time a fact was learned, for a string that
        had not moved.

        Facts come *after* the static preamble, never before or inside it: the
        preamble is the cacheable prefix, and appending means editing memory
        invalidates only the tail rather than every request that follows.

        They are ordered pinned-first then oldest-first, which is stable across
        turns. `updated_at` would have been the obvious sort and is wrong here
        -- reinforcing a fact would reshuffle the list and throw away the cache
        for a change nobody made.

        The ids come back so the caller can record that these were used without
        this method reaching for the clock or writing a row; it is called while
        assembling a prompt, and a prompt builder that writes to the database
        is a prompt builder you cannot call twice.
        """
        prompt = self.settings.system_preamble

        # An agent's persona, when the conversation is assigned to one. After
        # the static preamble and before the situation, which keeps it in the
        # stable-prefix region of the prompt: an agent rarely changes mid
        # conversation, so this does not churn the cache the way a fact does.
        # Additive, never a replacement -- the preamble carries what every
        # answer needs, and the agent specialises on top of it.
        agent = self.store.session_agent(session_id) if session_id else None
        if agent and agent.instructions and agent.instructions.strip():
            prompt = f"{prompt}\n\n{agent.instructions.strip()}"

        # A design conversation's working method. In the stable prefix beside
        # the agent, and for the same reason: a conversation's mode is fixed
        # when it starts, so this never churns the cache.
        mode = self.store.session_mode(session_id) if session_id else "chat"
        if mode == DESIGN:
            prompt = f"{prompt}\n\n{DESIGN_PREAMBLE}"

        situation = self._situation_block(session_id)
        if situation:
            prompt = f"{prompt}\n\n{situation}"

        # The standard this conversation settled on. After the situation: it
        # changes when the reader picks another look, which is rare but not
        # never, and the situation behind it never does.
        standard = self._design_block(session_id, mode)
        if standard:
            prompt = f"{prompt}\n\n{standard}"

        if not self._memory_enabled():
            return prompt, []

        facts = self.store.active_facts(limit=self.settings.memory_max_facts)
        if not facts:
            return prompt, []

        lines = "\n".join(
            f"- {fact.text[: self.settings.memory_fact_chars]}" for fact in facts
        )
        return (
            f"{prompt}\n\n"
            "What you already know about the user, from previous "
            f"conversations:\n{lines}",
            [fact.id for fact in facts],
        )

    def _situation_block(self, session_id: str | None) -> str:
        """The user's time and rough whereabouts, as their device reported them.

        Empty for a session that never said -- an API client with no browser
        behind it is an ordinary caller. Saying nothing is the right answer
        there: the preamble already tells the model to admit it does not know
        the date, and the server's own clock would be an answer to a different
        question.
        """
        if not session_id:
            return ""
        situation = self.store.session_situation(session_id)
        if not situation.known:
            return ""
        session = self.store.get_session(session_id)
        if not session:
            return ""
        # created_at is milliseconds, and is the moment the conversation began
        # rather than the moment this prompt is being assembled -- which is the
        # whole reason the block is stable enough to cache.
        started = datetime.fromtimestamp(session["created_at"] / 1000, tz=timezone.utc)
        return render_situation(situation, started)

    def _design_block(self, session_id: str | None, mode: str) -> str:
        """What the model should know about this conversation's design standard.

        In a design conversation the whole document rides along, so every turn
        is styled to it without the model having to fetch it first. In an
        ordinary chat it is one line: the chat may have made one deck an hour
        ago and moved on, and two thousand characters of type scale on every
        later turn would be paying for a brief nobody is using.
        """
        if not session_id:
            return ""
        chosen = self.store.session_design(session_id)
        if chosen is None:
            return ""
        if chosen == NO_DESIGN:
            return (
                "The user chose no design standard for this conversation. Use "
                "your own judgement for the look, and do not ask again unless "
                "they want to pick one."
            )
        found = design_resolve(self.store, chosen)
        if found is None:
            return ""
        name, markdown = found
        if mode != DESIGN:
            return (
                f"This conversation's design standard is {name!r}. Anything with "
                "a look -- slides, a sheet, a page -- follows it; ask_for_design "
                "returns it without asking."
            )
        tokens = tokens_for(chosen)
        theme = f"\n\nAs a theme: {json.dumps(tokens)}" if tokens else ""
        return (
            f"This conversation's design standard is {name!r}. Follow it for "
            "everything you make here; it has already been chosen, so do not "
            f"ask for one again unless the user wants a different look.\n\n"
            f"{markdown.strip()}{theme}"
        )

    def _design_offered(self, allowed_skills: set[str] | None) -> bool:
        """Whether the design question can be put in this conversation at all.

        Only when ask_for_design is switched on, and within an agent's subset
        where there is one: a reader who switched the chooser off has said they
        do not want to be asked, and a gate that asked anyway would be the
        chooser by another name.
        """
        if self.registry is None:
            return False
        skill = self.registry.get("ask_for_design")
        if skill is None or not skill.enabled or not skill.available:
            return False
        return allowed_skills is None or "ask_for_design" in allowed_skills

    def _memory_enabled(self) -> bool:
        """The "Remember between chats" switch, checked where it matters.

        Enforced here as well as in the curation pass: a switch that only stops
        new facts being written, while the ones already stored keep arriving in
        every prompt, has not turned anything off.
        """
        return self.store.get_settings(MEMORY_DEFAULTS)["memory.between_chats"]

    def build_window(
        self,
        history: list[StoredMessage],
        attached: dict[str, list[StoredAttachment]] | None = None,
        *,
        budget: int | None = None,
        system: str | None = None,
        session_id: str | None = None,
    ) -> list[Message]:
        """Most recent turns that fit the budget, oldest-first.

        Trimming from the head is a placeholder for real compaction
        (summarise the middle, keep head and tail) -- that lands in phase 5
        with the rest of the memory work.

        Attached files are charged against the same budget as the words around
        them, so a conversation full of screenshots trims to fewer turns rather
        than quietly overflowing the context.
        """
        attached = attached or {}
        budget = budget or (self.settings.context_tokens - self.settings.reply_tokens)
        # Built once. It used to be called twice here -- to charge the budget
        # and again to build the message -- which was free while it was an
        # attribute read and is two queries now that memory is in it. Worse,
        # the two calls could disagree if a fact were edited between them,
        # charging the window for a prompt it did not send.
        if system is None:
            # session_id matters here only for the budget: without it the
            # prompt built for costing would be missing the situation block
            # that the prompt actually sent contains.
            system, _ = self.build_system_prompt(session_id)
        budget -= estimate_tokens(system)

        # Which images ride along is decided first, newest backwards, so the
        # cost of a turn reflects what will actually be sent with it.
        carried: set[str] = set()
        for message in reversed(history):
            for item in reversed(attached.get(message.id, ())):
                if item.kind == "image" and len(carried) < MAX_WINDOW_IMAGES:
                    carried.add(item.id)

        carry_working = getattr(self.settings, "carry_working", True)

        selected: list[StoredMessage] = []
        used = 0
        for message in reversed(history):
            cost = message.tokens or estimate_tokens(message.content)
            cost += _attachment_cost(attached.get(message.id, ()), carried)
            # The carried recap is synthesised here, not part of the stored
            # tokens, so it has to be charged or a run of tool-heavy turns
            # overflows the window it was counted out of.
            if carry_working:
                cost += estimate_tokens(_carried_trace(message))
            if used + cost > budget and selected:
                break
            selected.append(message)
            used += cost
        selected.reverse()

        window = [Message(role="system", content=system)]
        window.extend(
            _to_message(m, attached.get(m.id, ()), carried, carry_working) for m in selected
        )
        return window

    # -- the turn ---------------------------------------------------------

    async def run_turn(
        self,
        session_id: str,
        user_text: str,
        *,
        attached: list[files.IncomingFile] | None = None,
        think: ThinkingLevel | None = None,
        prefer: str | None = None,
    ) -> AsyncIterator[str]:
        """Yield SSE frames for one turn.

        Frames: `meta` (ids, provider, model), `delta` (token), `done`, `error`.
        """
        user_message = self.store.add_message(session_id, "user", user_text)
        for incoming in attached or ():
            self.store.add_attachment(
                user_message.id,
                kind=incoming.kind,
                name=incoming.name,
                mime=incoming.mime,
                data=incoming.data,
                text=incoming.text,
            )

        route = await self.router.resolve(prefer)
        provider = route.provider
        history = self.store.list_messages(session_id)
        # Bytes, not just names: this is the one call that needs them.
        stored_files = self.store.attachments_for_session(session_id, with_data=True)
        system, fact_ids = self.build_system_prompt(session_id)
        window = self.build_window(history, stored_files, system=system)
        # One batched update, not one statement per fact per turn. This is what
        # "12 answers" under a fact on the memory page is counting, and what
        # keeps an unused inferred fact fading rather than lingering forever.
        self.store.mark_facts_used(fact_ids)

        assistant = self.store.add_message(
            session_id,
            "assistant",
            "",
            model=provider.model,
            provider=provider.name,
        )

        yield _sse(
            "meta",
            {
                "user_message_id": user_message.id,
                "message_id": assistant.id,
                "provider": provider.name,
                "model": provider.model,
                "source": route.reason,
            },
        )

        parts: list[str] = []
        # The working, kept so it can be stored with the answer. Reopening a
        # conversation used to give back the reply alone, which loses the one
        # thing worth auditing about a turn that ran skills: what it read.
        reasoning: list[str] = []
        used: list[dict] = []
        final: Chunk | None = None
        saved = False
        try:
            thinking_level = think or self.settings.ollama_think
            # The agent's skill subset, if the conversation is assigned to one.
            # `parsed_skills()` is None for "every enabled skill" and a list --
            # possibly empty -- for a restriction; the set is passed on to both
            # what the model is offered and what it is allowed to actually run.
            agent = self.store.session_agent(session_id)
            allowed_skills = (
                set(agent.parsed_skills())
                if agent and agent.parsed_skills() is not None
                else None
            )
            tools = self._skill_schemas(allowed_skills)
            max_rounds = getattr(self.settings, "max_tool_rounds", MAX_TOOL_ROUNDS)

            # One pass per round. A round ends when the model stops; if it
            # stopped to ask for skills, they run and the window goes back with
            # their answers appended. `parts` accumulates across rounds, so an
            # answer written either side of a skill call arrives as one reply.
            # Rounds lost to a tool call the backend could not parse.
            # Budgeted rather than unlimited: a model that cannot encode
            # an argument once will not manage it on the tenth attempt,
            # and each attempt costs a whole round.
            garbled = 0
            # Whether the design question has been settled this turn, either by
            # ask_for_design or by the gate below. Once is enough: a turn that
            # writes a deck and then a sheet should not ask twice.
            design_settled = False

            for _ in range(max_rounds):
                final = None
                round_text: list[str] = []
                round_state = {"garbled": False}

                async for chunk in self._stream_tolerating_garbled(
                    provider, window, thinking_level, tools, round_state
                ):
                    # The model's working, not its answer -- kept apart from
                    # `parts` so it is never mistaken for the reply, but stored
                    # alongside it.
                    if chunk.thinking:
                        reasoning.append(chunk.thinking)
                        yield _sse("thinking", {"text": chunk.thinking})
                    if chunk.text:
                        round_text.append(chunk.text)
                        parts.append(chunk.text)
                        yield _sse("delta", {"text": chunk.text})
                    if chunk.done:
                        final = chunk

                # Nothing usable arrived: the backend could not parse the tool call
                # the model wrote. The round is spent, so the model gets another and
                # a plain account of what went wrong -- the same courtesy a person
                # would get for a message that came through garbled.
                #
                # Deliberately not shown to the reader: Ollama's wording quotes the
                # entire unparsed payload, which is pages of their own document
                # handed back to them as an error.
                if round_state["garbled"]:
                    garbled += 1
                    if garbled > MAX_GARBLED_ROUNDS:
                        raise ProviderError(
                            "The model kept producing tool calls that could not be "
                            "read. This usually means it is struggling to encode a "
                            "long value -- try asking for a shorter one, or a "
                            "different model."
                        )
                    window.append(
                        Message(
                            role="user",
                            content=(
                                "Your last tool call could not be read: its arguments "
                                "were not valid JSON. That usually means a long value "
                                "with unescaped quotes or newlines in it. Send the "
                                "same call again with the arguments encoded properly. "
                                "A long value is fine -- it only has to be escaped."
                            ),
                        )
                    )
                    continue
                if final is None or not final.tool_calls:
                    break

                # What the model said on its way to asking, plus the asking
                # itself. Both have to go back or the next round replays a
                # conversation where nothing was requested.
                window.append(
                    Message(
                        role="assistant",
                        content="".join(round_text),
                        tool_calls=final.tool_calls,
                    )
                )

                for call in final.tool_calls:
                    yield _sse(
                        "tool_call", {"name": call.name, "arguments": call.arguments}
                    )
                    # Recorded before it runs, so a skill that raises or a turn
                    # the reader abandons still leaves evidence it was asked
                    # for. `finally` persists whatever this list holds.
                    record = {"name": call.name, "arguments": call.arguments}
                    # Which MCP server a tool came from, when it came from one.
                    # The client's result widget wears that service's mark, the
                    # way the Skills page does -- a row read as a brand is found
                    # faster than one read as a name.
                    source = (
                        getattr(self.registry.get(call.name), "server_name", None)
                        if self.registry
                        else None
                    )
                    if source:
                        record["server"] = source
                    used.append(record)

                    # An agent is only offered its own skills, but a model can
                    # still name one it was not given -- from habit, or because
                    # it is always-registered like recall. Refuse it before the
                    # approval prompt so a restricted agent cannot reach past its
                    # set, and tell the model plainly rather than silently.
                    if allowed_skills is not None and call.name not in allowed_skills:
                        result = (
                            f"{call.name} is not one of this agent's skills, so it "
                            "did not run. Answer without it."
                        )
                        record["result"] = result
                        record["denied"] = True
                        yield _sse(
                            "tool_result",
                            {"name": call.name, "text": result, "denied": True},
                        )
                        window.append(
                            Message(
                                role="tool",
                                content=result,
                                tool_call_id=call.id,
                                tool_name=call.name,
                            )
                        )
                        continue

                    skill_asked = self.registry.get(call.name) if self.registry else None
                    # Anything the skill needs that the model did not supply.
                    extra: dict = {}
                    # The standard picked at the gate, when the gate asked.
                    gated: str | None = None

                    # A skill whose whole purpose is to put a question to the
                    # reader asks it here, and that question stands in for the
                    # approval prompt -- answering it *is* the consent, and
                    # making someone approve a question before being asked it
                    # is two prompts for one decision.
                    if skill_asked is not None and skill_asked.asks == "design":
                        # The user may already have said which one -- "use the
                        # brutalist web design.md" -- in which case the model
                        # passes that through and there is nothing to ask. They
                        # answered the question before it was put; putting it
                        # anyway is the second prompt this whole path exists to
                        # avoid.
                        named = str(call.arguments.get("name") or "").strip()
                        picked = design_match(self.store, named) if named else None
                        # A conversation that already settled on a look keeps
                        # it: asking again on every deck is how a chooser gets
                        # dismissed without being read. `change` is the way
                        # back to the list, for "try a different style".
                        remembered = (
                            self.store.session_design(session_id) if session_id else None
                        )
                        wants_change = str(call.arguments.get("change")).lower() in (
                            "true", "1", "yes",
                        )
                        if picked is not None:
                            extra["choice"] = picked
                        elif remembered is not None and not named and not wants_change:
                            extra["choice"] = remembered
                        else:
                            request_id, waiter = self.choices.open()
                            yield _sse(
                                "design_choice",
                                {
                                    "id": request_id,
                                    "options": design_options(self.store),
                                    # What they asked for, when it matched
                                    # nothing. The chooser says so rather than
                                    # appearing for no visible reason -- an
                                    # unexplained list is how someone concludes
                                    # their own standard has gone missing.
                                    "asked_for": named or None,
                                },
                            )
                            # Silence here is a real answer rather than a
                            # refusal: the turn carries on and writes the thing
                            # unstyled.
                            extra["choice"] = await self.choices.wait(
                                request_id, waiter, NO_DESIGN
                            )
                        if session_id:
                            self.store.set_session_design(session_id, extra["choice"])
                        design_settled = True
                        decision = ALLOW_ONCE
                    else:
                        # The gate. A deck, a sheet or a page is about to be
                        # made in a conversation that has never been asked what
                        # it should look like -- the model went straight to the
                        # work. Asking here, before it runs, is what makes "ask
                        # the user about the design" a property of the harness
                        # rather than a hope about the model.
                        if (
                            not design_settled
                            and session_id
                            and skill_asked is not None
                            and skill_asked.wants_design(call.arguments)
                            and self.store.session_design(session_id) is None
                            and self._design_offered(allowed_skills)
                        ):
                            request_id, waiter = self.choices.open()
                            yield _sse(
                                "design_choice",
                                {
                                    "id": request_id,
                                    "options": design_options(self.store),
                                    "asked_for": None,
                                    # Which call is waiting, so the chooser can
                                    # say it is about to build something rather
                                    # than asking out of nowhere.
                                    "before": call.name,
                                },
                            )
                            gated = await self.choices.wait(request_id, waiter, NO_DESIGN)
                            self.store.set_session_design(session_id, gated)
                            design_settled = True
                            tokens = tokens_for(gated)
                            # A deck or a sheet is drawn from tokens, so a
                            # preset picked now can style what was already
                            # written -- no second generation.
                            if tokens and skill_asked.themed:
                                extra["theme_override"] = tokens


                        # Ask, unless something already standing says not to. The
                        # prompt is one more frame on the stream this answer is
                        # already arriving on, so the wait costs a pending request
                        # rather than a second trip through the model.
                        decision = self._standing_decision(call.name, session_id)
                        if decision is None:
                            request_id, waiter = self.approvals.open()
                            yield _sse(
                                "skill_approval",
                                {
                                    "id": request_id,
                                    "name": call.name,
                                    "arguments": call.arguments,
                                },
                            )
                            decision = await self.approvals.wait(request_id, waiter)
                            self._remember_decision(call.name, session_id, decision)

                    if not allowed(decision):
                        # A refusal is an answer. It goes into the window where
                        # the result would have gone, so the model knows it was
                        # refused and can say so rather than inventing one --
                        # and it is recorded, so reopening the conversation
                        # shows the call was asked for and declined.
                        result = (
                            f"The user declined to run {call.name}. Do not try "
                            "it again in this turn; answer without it, or say "
                            "what you would need."
                        )
                        record["result"] = result
                        record["denied"] = True
                    else:
                        # The conversation's standard, for a skill that takes a
                        # theme: whatever the model's own theme left out comes
                        # from here, so a deck is never unstyled just because
                        # the model forgot to copy the colours across.
                        if skill_asked is not None and skill_asked.themed and session_id:
                            defaults = tokens_for(self.store.session_design(session_id))
                            if defaults:
                                extra.setdefault("design_defaults", defaults)
                        result = await self._run_skill(call, session_id, extra=extra)
                        result += _gated_note(self.store, gated, extra, call.name)
                        record["result"] = result

                    yield _sse(
                        "tool_result",
                        {
                            "name": call.name,
                            "text": result,
                            "denied": record.get("denied", False),
                        },
                    )
                    # A skill can change something on screen beyond its text --
                    # write_canvas rewrites the document in the side panel. Only
                    # a call that actually ran, so a declined one leaves the
                    # panel showing what it already had rather than nothing.
                    skill = self.registry.get(call.name) if self.registry else None
                    if (
                        not record.get("denied")
                        and skill is not None
                        and skill.surfaces == "canvas"
                        and session_id
                    ):
                        yield _sse(
                            "canvas",
                            {
                                "canvases": [
                                    c.to_dict()
                                    for c in self.store.session_canvases(session_id)
                                ]
                            },
                        )
                    window.append(
                        Message(
                            role="tool",
                            content=result,
                            tool_call_id=call.id,
                            tool_name=call.name,
                        )
                    )
        except ProviderError as exc:
            self.router.invalidate_health()
            # Keep whatever arrived before the failure rather than dropping it.
            self._persist(assistant.id, parts, None, provider, reasoning, used)
            saved = True
            yield _sse("error", {"message": str(exc), "provider": provider.name})
            return
        finally:
            # Covers client disconnect (CancelledError/GeneratorExit) as well as
            # anything unexpected: a phone dropping off cellular mid-answer
            # should still leave a coherent conversation behind.
            if not saved:
                self._persist(assistant.id, parts, final, provider, reasoning, used)

        # A turn that ends with nothing to show is a failure, even though every
        # frame arrived and no exception was raised. Left alone it reaches the
        # thread as an assistant bubble that never fills, which reads as a hang
        # and gives no clue whose fault it was.
        #
        # There are two ways to get here and they have different fixes, so they
        # get different sentences.
        # The loop only breaks when the model stops asking for skills, so if the
        # last round still carried tool calls it ran out of rounds rather than
        # finishing -- there is more it wanted to do. The client offers a
        # Continue in that case, which just sends another turn with fresh rounds.
        exhausted = final is not None and bool(final.tool_calls)

        if not "".join(parts).strip():
            yield _sse(
                "error",
                {
                    "message": _silent_turn_reason(final, max_rounds),
                    "provider": provider.name,
                    # Continue is worth offering only when there were rounds to
                    # run out of; a genuinely empty answer is a different fault.
                    "continuable": exhausted,
                },
            )
            return

        yield _sse(
            "done",
            {
                "message_id": assistant.id,
                "tokens": final.completion_tokens if final else None,
                "truncated": exhausted,
            },
        )

    async def _stream_tolerating_garbled(
        self, provider, window, think, tools, state: dict
    ):
        """`_stream_with_recovery`, minus the one failure a retry can fix.

        A tool call the backend could not parse raises out of the stream
        mid-round. Caught here and reported through `state` rather than as an
        exception, so the round loop can spend another round on it instead of
        unwinding the whole turn -- the caller's body is an ordinary
        `async for` either way.
        """
        try:
            async for chunk in self._stream_with_recovery(
                provider, window, think=think, tools=tools
            ):
                yield chunk
        except MalformedToolCall:
            state["garbled"] = True

    async def _stream_with_recovery(
        self,
        provider,
        window: list[Message],
        *,
        think: str | None = None,
        tools: list[dict] | None = None,
    ) -> AsyncIterator[Chunk]:
        """Section 7: on OOM or overflow, retry once with a smaller window.

        The tool loop wraps *around* this rather than inside it, so overflow
        recovery still applies to every round of a turn -- including the ones
        that come back carrying a skill's output.
        """
        try:
            async for chunk in provider.stream(window, think=think, tools=tools):
                yield chunk
            return
        except ContextOverflow:
            pass  # fall through to the reduced-context retry

        reduced = [window[0], *window[-5:]] if len(window) > 6 else window
        async for chunk in provider.stream(reduced, think=think, tools=tools):
            yield chunk

    # -- approval ---------------------------------------------------------

    def _standing_decision(self, name: str, session_id: str | None) -> str | None:
        """A decision already made, or None when the reader has to be asked.

        Checked in widening order -- the switch, then the stored "always", then
        this conversation's own grants -- because each is cheaper than the one
        after it and the first hit ends the question.
        """
        if not self.store.get_settings(APPROVAL_DEFAULTS)["skills.ask_first"]:
            return ALLOW_ONCE
        if name in read_auto_approved(self.store):
            return ALLOW_ALWAYS
        if session_id and name in self._session_grants.get(session_id, ()):
            return ALLOW_SESSION
        return None

    def _remember_decision(self, name: str, session_id: str | None, decision: str) -> None:
        """Widen the grant, when the reader asked for it to be widened.

        Only the two widening answers are recorded. "Once" writes nothing, and
        a refusal writes nothing either: a no is about this call, and storing
        it would turn one cautious answer into a skill that silently stops
        working with nothing on screen to say why.
        """
        if decision == ALLOW_ALWAYS:
            write_auto_approved(self.store, read_auto_approved(self.store) | {name})
        elif decision == ALLOW_SESSION and session_id:
            self._session_grants.setdefault(session_id, set()).add(name)

    async def _run_skill(
        self, call, session_id: str | None = None, extra: dict | None = None
    ) -> str:
        """One skill call, reduced to text the model can read.

        Every failure returns rather than raises. A model that mistypes an
        argument name should cost one round and be told what it got wrong --
        not kill the conversation with a TypeError.
        """
        skill = self.registry.get(call.name) if self.registry else None
        if skill is None:
            known = ", ".join(name for name, _ in self.registry.enabled()) if self.registry else ""
            return (
                f"There is no skill called {call.name!r}."
                + (f" Available: {known}." if known else "")
            )
        if not skill.enabled:
            return f"{call.name} is switched off."
        arguments = dict(call.arguments)
        if skill.wants_context and session_id:
            # Assigned after the copy, so a model that hallucinates a `context`
            # argument cannot talk over the real one.
            arguments["context"] = self.store.session_situation(session_id)
        if skill.wants_session and session_id:
            # Same guard as `context`: overwritten after the copy so a
            # hallucinated `session` argument cannot point the skill at another
            # conversation.
            arguments["session"] = session_id
        # Whatever the turn loop resolved on the skill's behalf -- the reader's
        # design pick. Applied last, for the same reason: the model does not
        # get to supply it.
        arguments.update(extra or {})
        try:
            result = await skill.use(**arguments)
        except TypeError as exc:
            # Almost always a hallucinated or missing argument name.
            return f"{call.name} was called wrongly: {exc}"
        except Exception as exc:
            return f"{call.name} failed: {type(exc).__name__}: {exc}"
        return str(result)[:MAX_RESULT_CHARS]

    def _persist(
        self,
        message_id: str,
        parts: list[str],
        final: Chunk | None,
        provider,
        reasoning: list[str] | None = None,
        skills: list[dict] | None = None,
    ) -> None:
        text = "".join(parts)
        self.store.update_message(
            message_id,
            text,
            reasoning="".join(reasoning or ()) or None,
            skills=skills or None,
            tokens=(final.completion_tokens if final else None)
            or (estimate_tokens(text) if text else None),
            model=provider.model,
            provider=provider.name,
        )

    # -- titles -----------------------------------------------------------

    async def ensure_title(self, session_id: str) -> str | None:
        """Name a session from its first exchange. Runs off the response path."""
        session = self.store.get_session(session_id)
        if not session or session.get("title"):
            return None

        history = self.store.list_messages(session_id)
        first_user = next((m for m in history if m.role == "user"), None)
        if not first_user:
            return None

        # A turn can be nothing but a dropped image. Name it after the file
        # rather than leaving the conversation blank in the sidebar.
        seed = first_user.content.strip()
        if not seed:
            named = self.store.attachments_for_session(session_id).get(first_user.id, ())
            seed = ", ".join(a.name for a in named)
        if not seed:
            return None

        title = _truncate_title(seed)
        try:
            route = await self.router.resolve()
            prompt = [
                Message(
                    role="system",
                    content=(
                        "Title this conversation in at most six words. "
                        "Reply with the title alone -- no quotes, no punctuation "
                        "at the end, no preamble."
                    ),
                ),
                Message(role="user", content=seed[:2000]),
            ]
            generated = []
            async for chunk in route.provider.stream(prompt):
                if chunk.text:
                    generated.append(chunk.text)
            candidate = "".join(generated).strip().strip('"').splitlines()[0]
            if candidate:
                title = _truncate_title(candidate)
        except (ProviderError, IndexError):
            pass  # the truncated first message is a perfectly good fallback

        self.store.rename_session(session_id, title)
        return title


def _gated_note(store: Store, gated: str | None, extra: dict, tool: str) -> str:
    """What the model is told when the look was chosen after it wrote the thing.

    Three cases. Nothing was asked, or the reader declined: nothing to add. A
    preset was picked for a deck or a sheet: its tokens were already applied,
    so the model only needs to know which standard it is now working to. Any
    other pick -- the reader's own standard, or a page -- cannot be applied
    without the model, so the document goes back with an instruction to redo
    the work to it, in this same turn.
    """
    if not gated or gated == NO_DESIGN:
        return ""
    found = design_resolve(store, gated)
    if found is None:
        return ""
    name, markdown = found
    if "theme_override" in extra:
        return (
            f"\n\nThe user picked the {name!r} design standard for this "
            "conversation, and its colours and type were applied to what you "
            "just wrote. Follow its layout and voice rules in anything further."
        )
    return (
        f"\n\nBefore this ran, the user picked the {name!r} design standard for "
        f"this conversation:\n\n{markdown.strip()}\n\n---\nWhat you just wrote "
        f"was made without it. Call {tool} again now with the same title, "
        "restyled to this standard, so the user sees the finished version."
    )


def _carried_trace(stored: StoredMessage) -> str:
    """A compact recap of an assistant turn's working, for later turns.

    The turn loop feeds tool results and thinking to the model live, but only
    the final answer is stored as the message body -- so on the next turn, or
    after a Continue, the model would otherwise see its conclusion with no
    memory of what it read to reach it. This rebuilds a short note: the tools it
    called with a trimmed line of each result, then the tail of its reasoning.
    Empty for anything but an assistant turn that actually did some working, so
    a plain chat exchange carries nothing extra.
    """
    if stored.role != "assistant":
        return ""

    lines: list[str] = []
    if stored.skills:
        try:
            calls = json.loads(stored.skills)
        except (ValueError, TypeError):
            calls = []
        for call in calls if isinstance(calls, list) else ():
            name = call.get("name", "a tool") if isinstance(call, dict) else "a tool"
            result = " ".join(str(call.get("result") or "").split()) if isinstance(call, dict) else ""
            if len(result) > CARRIED_RESULT_CHARS:
                result = result[:CARRIED_RESULT_CHARS] + "…"
            lines.append(f"- {name}: {result}" if result else f"- {name}")

    trace: list[str] = []
    if lines:
        trace.append("Tools you used and what they returned:\n" + "\n".join(lines))
    if stored.reasoning and stored.reasoning.strip():
        tail = " ".join(stored.reasoning.split())
        if len(tail) > CARRIED_REASONING_CHARS:
            tail = "…" + tail[-CARRIED_REASONING_CHARS:]
        trace.append("Your reasoning then: " + tail)

    if not trace:
        return ""
    return "[Earlier this conversation —\n" + "\n\n".join(trace) + "]"


def _to_message(
    stored: StoredMessage, attached, carried: set[str], carry_working: bool = False
) -> Message:
    """One stored turn as the providers see it.

    Text files are pasted in ahead of what the user typed, so their question
    lands last and reads as being about the files above it. Images travel
    beside the text rather than in it -- see providers/base.py -- except for
    the older ones, which are left as a line of text saying they were here.

    When `carry_working` is on, an assistant turn also carries a compact recap
    of the tools it ran and the tail of its reasoning, so a later turn keeps the
    context the live loop had -- see `_carried_trace`.
    """
    text: list[str] = []
    images: list[Image] = []

    for item in attached:
        if item.kind != "image":
            text.append(files.as_prompt_text(item.name, _readable(item)))
        elif item.id in carried:
            # Files stored before uploads were normalised can still be in a
            # format the runner refuses, which would fail this turn and every
            # later one in the conversation. Converting on the way out costs a
            # few milliseconds and leaves the stored original untouched.
            name, mime, data = item.name, item.mime, item.data
            if mime not in files.STORABLE_MIMES:
                name, mime, data = files.normalize_image(name, mime, data)
            images.append(Image(name=name, mime=mime, data=data))
        else:
            text.append(f"[earlier image: {item.name}]")

    if stored.content:
        text.append(stored.content)
    if carry_working:
        trace = _carried_trace(stored)
        if trace:
            text.append(trace)

    return Message(role=stored.role, content="\n\n".join(text), images=tuple(images))


def _readable(item) -> str:
    """The words in an attachment.

    A text file is its own bytes; a document was read at upload and the result
    is in the column beside them.
    """
    if item.kind == "document":
        return item.text or ""
    return (item.data or b"").decode("utf-8", "replace")


def _attachment_cost(attached, carried: set[str]) -> int:
    total = 0
    for item in attached:
        if item.kind != "image":
            total += estimate_tokens(files.as_prompt_text(item.name, _readable(item)))
        elif item.id in carried:
            total += IMAGE_TOKENS
        else:
            total += estimate_tokens(f"[earlier image: {item.name}]")
    return total


def _silent_turn_reason(final: Chunk | None, rounds: int = MAX_TOOL_ROUNDS) -> str:
    """Why a turn produced no visible answer, in a sentence the user reads.

    The message names the missing piece rather than the symptom, because the
    symptom -- an empty bubble -- is the same in every case and tells nobody
    anything.
    """
    if final is not None and final.tool_calls:
        # The loop ran its full allowance of rounds and the model was still
        # asking for more rather than writing an answer -- so the last round's
        # calls were never run. Naming them is the useful part: it is almost
        # always the same skill over and over, and the fix is in what that
        # skill returns rather than anywhere near here.
        asked = ", ".join(sorted({call.name for call in final.tool_calls})) or "a skill"
        return (
            f"The model used all {rounds} rounds of skill calls without "
            f"writing an answer, and was still asking for {asked}. Press "
            "Continue to let it keep going, or run `python -m tools.why_silent` "
            "to see what it was told each time."
        )
    return (
        "The model finished without saying anything. That usually means it "
        "believed it should use a skill and had none offered: check that the "
        "system preamble isn't promising abilities the request doesn't declare "
        "in `tools`."
    )


def _truncate_title(text: str, limit: int = 60) -> str:
    cleaned = " ".join(text.split())
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: limit - 1].rstrip() + "…"


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
