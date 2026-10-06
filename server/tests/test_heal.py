"""Self-healing tool calls: what a model got nearly right is mended, what it
got wrong is answered with how to get it right, and nothing is guessed at."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.db import Database
from app.heal import calls_in_text, heal, match_name
from app.orchestrator import Orchestrator
from app.providers.base import Chunk, ToolCall, decode_arguments
from app.providers.ollama import _parse_call
from app.skills.registry import Registry
from app.skills.skill import Skill
from app.store import Store

SEARCH = {
    "name": "web_search",
    "description": "Search the web.",
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string"},
            "num_results": {"type": "integer"},
            "fresh": {"type": "boolean"},
            "sites": {"type": "array", "items": {"type": "string"}},
            "kind": {"type": "string", "enum": ["news", "web"]},
        },
        "required": ["query"],
    },
}
READ_PAGE = {"name": "read_page", "description": "", "parameters": {"type": "object", "properties": {}}}
TOOLS = [SEARCH, READ_PAGE]


def _call(name="web_search", **arguments) -> ToolCall:
    return ToolCall(id="c1", name=name, arguments=arguments)


# -- decoding ------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw, expected",
    [
        ('{"query": "x"}', {"query": "x"}),
        # A long value with raw newlines in it: the usual way a canvas breaks.
        ('{"content": "<html>\n<body>\n</body>"}', {"content": "<html>\n<body>\n</body>"}),
        ('```json\n{"query": "x"}\n```', {"query": "x"}),
        ('Here you go: {"query": "x"}', {"query": "x"}),
        ('{"query": "x",}', {"query": "x"}),
        # Off a real gpt-oss run: a stray empty key at the end.
        ('{"numResults":10,"query":"x",""}', {"numResults": 10, "query": "x"}),
        ("{'query': 'x', 'fresh': True}", {"query": "x", "fresh": True}),
        ({"query": "x"}, {"query": "x"}),
        ("", {}),
        (None, {}),
    ],
)
def test_arguments_decode_leniently(raw, expected):
    assert decode_arguments(raw) == (expected, None)


def test_a_cut_off_value_is_not_finished_off():
    """Half a document run as though it were the whole one is worse than a retry."""
    arguments, unreadable = decode_arguments('{"content": "<html><body>')
    assert arguments == {}
    assert unreadable == '{"content": "<html><body>'


def test_ollama_keeps_what_it_could_not_read():
    call = _parse_call({"function": {"name": "web_search", "arguments": "{oops"}}, 0)
    assert call.arguments == {} and call.unreadable == "{oops"


# -- names ---------------------------------------------------------------------


@pytest.mark.parametrize(
    "written",
    [
        "functions.web_search",
        "web_search<|channel|>commentary",
        "webSearch",
        "Web-Search",
        "web_serach",
        "`web_search()`",
    ],
)
def test_a_mangled_name_finds_its_tool(written):
    healed = heal(_call(written, query="x"), TOOLS)
    assert healed.call.name == "web_search"
    assert healed.problem is None
    assert healed.notes and written in healed.notes[0]


def test_a_correct_name_is_left_alone_and_unremarked():
    healed = heal(_call(query="x"), TOOLS)
    assert healed.call == _call(query="x")
    assert healed.notes == ()


def test_a_name_that_is_nothing_like_a_tool_is_not_guessed():
    assert match_name("send_email", {"web_search": {}, "read_page": {}}) is None
    healed = heal(_call("send_email", to="x"), TOOLS)
    assert healed.call.name == "send_email" and healed.notes == ()


def test_only_offered_tools_are_healed_into():
    """A tool this turn did not offer is not reachable by misspelling it."""
    assert heal(_call("web_serach", query="x"), [READ_PAGE]).call.name == "web_serach"


def test_two_equally_close_tools_are_not_chosen_between():
    tools = [{"name": "read_file1"}, {"name": "read_file2"}]
    assert match_name("read_file", {t["name"]: {} for t in tools}) is None


# -- arguments -----------------------------------------------------------------


def test_arguments_in_an_envelope_are_unwrapped():
    assert heal(_call(arguments={"query": "x"}), TOOLS).call.arguments == {"query": "x"}
    assert heal(_call(parameters='{"query": "x"}'), TOOLS).call.arguments == {"query": "x"}
    whole = _call(name="web_search", arguments={"query": "x"})
    assert heal(whole, TOOLS).call.arguments == {"query": "x"}


def test_misspelled_argument_names_are_read_as_the_declared_ones():
    healed = heal(_call(Query="x", numResults=3, fersh=True), TOOLS)
    assert healed.call.arguments == {"query": "x", "num_results": 3, "fresh": True}
    assert any("'Query' read as 'query'" in n for n in healed.notes)


def test_an_unknown_argument_unlike_any_is_passed_through():
    """Skills read their own aliases (`html` for a canvas's content) from **extra."""
    assert heal(_call(query="x", html="<p>"), TOOLS).call.arguments == {"query": "x", "html": "<p>"}


def test_a_declared_name_given_twice_is_not_overwritten():
    healed = heal(_call(query="x", Query="y"), TOOLS)
    assert healed.call.arguments["query"] == "x"


def test_values_are_typed_as_the_schema_says():
    healed = heal(
        _call(query=42, num_results="7", fresh="yes", sites='["a.com", "b.com"]', kind="News"),
        TOOLS,
    )
    assert healed.call.arguments == {
        "query": "42", "num_results": 7, "fresh": True, "sites": ["a.com", "b.com"], "kind": "news",
    }
    # Typing is not a mistake worth telling the model about.
    assert healed.notes == ()


def test_one_item_where_a_list_was_asked_for_becomes_a_list():
    assert heal(_call(query="x", sites="a.com"), TOOLS).call.arguments["sites"] == ["a.com"]


def test_a_null_optional_argument_falls_to_the_default():
    assert heal(_call(query="x", num_results=None), TOOLS).call.arguments == {"query": "x"}


def test_a_value_that_cannot_be_typed_is_left_for_the_skill():
    assert heal(_call(query="x", num_results="lots"), TOOLS).call.arguments["num_results"] == "lots"


# -- what cannot be mended -----------------------------------------------------


def test_unreadable_arguments_are_answered_not_run():
    call = ToolCall(id="c1", name="web_search", arguments={}, unreadable="{oops")
    healed = heal(call, TOOLS)
    assert "not valid JSON" in healed.problem
    assert "query (string)" in healed.problem


def test_no_arguments_where_some_are_required_is_answered_not_run():
    healed = heal(_call(), TOOLS)
    assert "no arguments" in healed.problem
    assert "num_results (integer), optional" in healed.problem


def test_a_tool_that_takes_nothing_runs_with_nothing():
    assert heal(_call("read_page"), TOOLS).problem is None


# -- calls written as text -----------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        '<tool_call>\n{"name": "web_search", "arguments": {"query": "x"}}\n</tool_call>',
        '{"name": "web_search", "arguments": {"query": "x"}}',
        '```json\n{"name": "functions.web_search", "parameters": {"query": "x"}}\n```',
        '{"name": "web_search", "query": "x"}',
        '{"type": "function", "function": {"name": "web_search", "arguments": "{\\"query\\": \\"x\\"}"}}',
    ],
)
def test_a_call_written_as_text_is_read_as_one(text):
    (call,) = calls_in_text(text, TOOLS)
    assert call.name == "web_search" and call.arguments == {"query": "x"}


def test_several_tagged_calls_are_all_read():
    text = (
        '<tool_call>{"name": "web_search", "arguments": {"query": "a"}}</tool_call>\n'
        '<tool_call>{"name": "read_page", "arguments": {}}</tool_call>'
    )
    assert [c.name for c in calls_in_text(text, TOOLS)] == ["web_search", "read_page"]


@pytest.mark.parametrize(
    "text",
    [
        # An answer that shows a call is an answer.
        'To search, I would send:\n{"name": "web_search", "arguments": {"query": "x"}}',
        '<tool_call>{"name": "web_search", "arguments": {}}</tool_call> and then I will summarise.',
        # Not a tool this turn has, and not fuzzily one either.
        '{"name": "web_serach", "arguments": {"query": "x"}}',
        '{"name": "Ada", "role": "engineer"}',
        "The answer is 42.",
    ],
)
def test_prose_and_data_are_not_read_as_calls(text):
    assert calls_in_text(text, TOOLS) == ()


def test_no_tools_offered_means_no_calls_read():
    assert calls_in_text('{"name": "web_search", "arguments": {}}', None) == ()


# -- in a turn -----------------------------------------------------------------


class _Search(Skill):
    def __init__(self) -> None:
        super().__init__(name=SEARCH["name"], description=SEARCH["description"], parameters=SEARCH["parameters"])
        self.ran: list[dict] = []

    async def use(self, query: str, num_results: int = 5, fresh: bool = False, sites=None, kind=None) -> str:
        self.ran.append({"query": query, "num_results": num_results})
        return f"{num_results} results for {query}"


class _Scripted:
    """Answers each round with the next scripted chunk."""

    name = "mock"
    model = "mock"

    def __init__(self, *rounds: Chunk) -> None:
        self.rounds = list(rounds)
        self.saw: list = []

    async def stream(self, messages, *, think=None, tools=None):
        self.saw.append(list(messages))
        chunk = self.rounds.pop(0)
        if chunk.text and chunk.done:
            yield Chunk(text=chunk.text)
            chunk = Chunk(done=True, tool_calls=chunk.tool_calls)
        yield chunk

    async def embed(self, texts):
        return [[0.0] * 8 for _ in texts]

    async def health(self):
        return True


@pytest.fixture
def store(tmp_path: Path) -> Store:
    return Store(Database(tmp_path / "heal.db"))


def _orch(store: Store, provider, skill: Skill) -> Orchestrator:
    registry = Registry()
    registry.register(skill)
    router = type("R", (), {})()

    async def resolve(prefer=None):
        return type("Route", (), {"provider": provider, "reason": "local"})()

    router.resolve = resolve
    router.invalidate_health = lambda: None
    settings = type("S", (), {
        "system_preamble": "You help.", "context_tokens": 8192, "reply_tokens": 1024,
        "ollama_think": "medium", "memory_max_facts": 20, "memory_fact_chars": 200,
    })()
    return Orchestrator(settings, store, router, registry)


@pytest.mark.asyncio
async def test_a_misspelled_call_runs_the_first_time(store: Store):
    skill = _Search()
    provider = _Scripted(
        Chunk(done=True, tool_calls=(ToolCall("c1", "functions.webSearch", {"Query": "bom", "num_results": "3"}),)),
        Chunk(text="Found it.", done=True),
    )
    session = store.create_session()["id"]

    joined = "".join([f async for f in _orch(store, provider, skill).run_turn(session, "search")])

    assert skill.ran == [{"query": "bom", "num_results": 3}]
    assert "Found it." in joined
    # The model is told what was mended, beside the result, and the window
    # replays the call as it ran.
    replay = provider.saw[1]
    asked = next(m for m in replay if m.tool_calls)
    assert asked.tool_calls[0].name == "web_search"
    result = next(m for m in replay if m.role == "tool")
    assert "3 results for bom" in result.content
    assert "mended" in result.content and "'Query' read as 'query'" in result.content


@pytest.mark.asyncio
async def test_a_call_written_as_text_runs_and_leaves_the_reply(store: Store):
    skill = _Search()
    provider = _Scripted(
        Chunk(text='<tool_call>{"name": "web_search", "arguments": {"query": "bom"}}</tool_call>', done=True),
        Chunk(text="Found it.", done=True),
    )
    session = store.create_session()["id"]

    joined = "".join([f async for f in _orch(store, provider, skill).run_turn(session, "search")])

    assert skill.ran == [{"query": "bom", "num_results": 5}]
    assert "event: replace" in joined
    stored = store.list_messages(session)[-1].content
    assert stored.strip() == "Found it."


@pytest.mark.asyncio
async def test_an_unreadable_call_is_answered_without_running(store: Store):
    skill = _Search()
    provider = _Scripted(
        Chunk(done=True, tool_calls=(ToolCall("c1", "web_search", {}, unreadable='{"query": "b'),)),
        Chunk(done=True, tool_calls=(ToolCall("c2", "web_search", {"query": "bom"}),)),
        Chunk(text="Found it.", done=True),
    )
    session = store.create_session()["id"]

    "".join([f async for f in _orch(store, provider, skill).run_turn(session, "search")])

    assert skill.ran == [{"query": "bom", "num_results": 5}]
    told = next(m for m in provider.saw[1] if m.role == "tool")
    assert "not valid JSON" in told.content and "query (string)" in told.content
