"""Group chats, and what an ordinary chat is offered after the office pivot."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import group
from app.config import Settings
from app.db import Database
from app.main import create_app
from app.orchestrator import Orchestrator
from app.providers.base import Chunk
from app.skills.canvas import ReadCanvas, WriteCanvas
from app.skills.registry import Registry
from app.skills.sheet import WriteSheet
from app.skills.skill import Skill
from app.skills.slides import WriteSlides
from app.skills.wireframe import WriteWireframe
from app.store import Store


@pytest.fixture
def store(tmp_path: Path) -> Store:
    return Store(Database(tmp_path / "groups.db"))


def _events(joined: str, name: str) -> list[dict]:
    return [
        json.loads(block.split("data: ", 1)[1])
        for block in joined.split("\n\n")
        if block.startswith(f"event: {name}\n")
    ]


# -- who answers ----------------------------------------------------------------

NAMES = {"a1": "Secretary", "a2": "Analyst", "a3": "Research team"}


def test_a_mention_picks_who_answers_in_the_order_named():
    members = ["a1", "a2", "a3"]
    assert group.speakers("@analyst can you check this", members, NAMES) == ["a2"]
    assert group.speakers("@Analyst then @secretary", members, NAMES) == ["a2", "a1"]
    # A multi-word name is matched whole.
    assert group.speakers("ask @Research team", members, NAMES) == ["a3"]


def test_everyone_answers_an_at_everyone():
    assert group.speakers("@everyone thoughts?", ["a1", "a2"], NAMES) == ["a1", "a2"]
    assert group.speakers("@all thoughts?", ["a1", "a2"], NAMES) == ["a1", "a2"]


def test_no_mention_stays_with_whoever_answered_last():
    members = ["a1", "a2"]
    assert group.speakers("and then?", members, NAMES, last="a2") == ["a2"]
    # Nobody has answered yet: the first member.
    assert group.speakers("hello", members, NAMES) == ["a1"]
    # The composer's pick, when there is one.
    assert group.speakers("hello", members, NAMES, last="a1", reply_as="a2") == ["a2"]
    # An email address is not a mention.
    assert group.speakers("mail bob@analyst.com", members, NAMES, last="a1") == ["a1"]


def test_a_member_hears_the_others_as_people_talking_to_it(store: Store):
    sid = store.create_session()["id"]
    store.add_message(sid, "user", "Plan the offsite")
    theirs = store.add_message(sid, "assistant", "I booked Friday.")
    mine = store.add_message(sid, "assistant", "Budget is 2k.")
    authors = {theirs.id: "a1", mine.id: "a2"}
    heard = group.as_heard_by(store.list_messages(sid), authors, "a2", NAMES)
    assert [m.role for m in heard] == ["user", "user", "assistant"]
    assert heard[1].content == "[Secretary]\nI booked Friday."
    assert heard[2].content == "Budget is 2k."


# -- the turn ---------------------------------------------------------------------


class _Recording:
    name = "mock"
    model = "mock"

    def __init__(self):
        self.calls: list[dict] = []

    async def stream(self, messages, *, think=None, tools=None):
        self.calls.append({
            "system": messages[0].content,
            "roles": [m.role for m in messages[1:]],
            "contents": [m.content for m in messages[1:]],
            "tools": {t["name"] for t in tools or []},
        })
        yield Chunk(text="Done.", done=True)

    async def embed(self, texts):
        return [[0.0] * 8 for _ in texts]

    async def health(self):
        return True


class _Connector(Skill):
    server_name = "mail"

    def __init__(self):
        super().__init__(name="send_email", description="Send an email.")

    async def use(self, **kwargs):
        return "sent"


def _orchestrator(store: Store) -> tuple[Orchestrator, _Recording]:
    registry = Registry()
    for skill in (WriteSlides(store), WriteWireframe(store), WriteSheet(store),
                  WriteCanvas(store), ReadCanvas(store), _Connector()):
        registry.register(skill)
    provider = _Recording()

    async def resolve(prefer=None):
        return type("Route", (), {"provider": provider, "reason": "local"})()

    router = type("R", (), {})()
    router.resolve = resolve
    router.invalidate_health = lambda: None
    settings = type("S", (), {
        "system_preamble": "You help.", "context_tokens": 8192, "reply_tokens": 1024,
        "ollama_think": "medium", "memory_max_facts": 20, "memory_fact_chars": 200,
    })()
    return Orchestrator(settings, store, router, registry), provider


async def _run(orch, sid, text, **kw) -> str:
    return "".join([frame async for frame in orch.run_turn(sid, text, **kw)])


@pytest.mark.asyncio
async def test_a_chat_is_not_offered_the_studio(store: Store):
    orch, provider = _orchestrator(store)
    await _run(orch, store.create_session()["id"], "Make me a table")
    await _run(orch, store.create_session(mode="design")["id"], "Make me a deck")
    chat, design = provider.calls
    assert {"write_sheet", "write_canvas"} <= chat["tools"]
    assert not chat["tools"] & {"write_slides", "write_wireframe"}
    assert {"write_slides", "write_wireframe"} <= design["tools"]


@pytest.mark.asyncio
async def test_a_deck_pinned_in_a_chat_is_said_to_be_off(store: Store):
    orch, provider = _orchestrator(store)
    joined = await _run(orch, store.create_session()["id"], "A deck", make="slides")
    meta = _events(joined, "meta")[0]
    assert meta["make"]["requested"] == "slides" and meta["make"]["applied"] is None
    # Nothing was taken off the shelf for a pin that was not applied.
    assert "write_sheet" in provider.calls[0]["tools"]


@pytest.mark.asyncio
async def test_connectors_in_an_agent_list_stand_for_the_mcp_tools(store: Store):
    orch, provider = _orchestrator(store)
    agent = store.create_agent("Secretary", skills=["write_canvas", group.CONNECTORS])
    sid = store.create_session()["id"]
    store.set_session_agent(sid, agent.id)
    await _run(orch, sid, "Email Sam")
    assert provider.calls[0]["tools"] == {"write_canvas", "send_email"}


@pytest.mark.asyncio
async def test_the_next_member_answers_without_a_new_user_message(store: Store):
    orch, provider = _orchestrator(store)
    secretary = store.create_agent("Secretary")
    analyst = store.create_agent("Analyst")
    sid = store.create_session()["id"]
    store.set_session_members(sid, [secretary.id, analyst.id])

    store.set_session_agent(sid, secretary.id)
    first = _events(await _run(orch, sid, "@everyone plan it"), "meta")[0]
    store.set_session_agent(sid, analyst.id)
    second = _events(await _run(orch, sid, "@everyone plan it", reply_only=True), "meta")[0]

    assert first["agent_id"] == secretary.id and second["agent_id"] == analyst.id
    assert second["user_message_id"] is None
    roles = [m.role for m in store.list_messages(sid)]
    assert roles == ["user", "assistant", "assistant"]
    # The analyst heard the secretary as someone talking to it, and was told
    # who is in the room.
    heard = provider.calls[1]
    assert heard["roles"] == ["user", "user"]
    assert heard["contents"][1] == "[Secretary]\nDone."
    assert "group chat" in heard["system"] and "Secretary" in heard["system"]
    assert store.message_authors(sid) == {
        m.id: a for m, a in zip(store.list_messages(sid)[1:], [secretary.id, analyst.id])
    }


# -- over HTTP ------------------------------------------------------------------


@pytest.fixture
def client(tmp_path: Path, monkeypatch) -> TestClient:
    seen: list[dict] = []

    async def fake_run_turn(self, session_id, text, **kw):
        agent = self.store.session_agent(session_id)
        seen.append({"agent": agent.name if agent else None, "reply_only": kw.get("reply_only")})
        if not kw.get("reply_only"):
            self.store.add_message(session_id, "user", text)
        reply = self.store.add_message(session_id, "assistant", f"{agent.name if agent else 'Bom'} here")
        if agent:
            self.store.set_message_author(reply.id, agent.id)
        yield f'event: meta\ndata: {json.dumps({"agent_id": agent.id if agent else None})}\n\n'
        yield "event: done\ndata: {}\n\n"

    monkeypatch.setattr(Orchestrator, "run_turn", fake_run_turn)
    app = create_app(Settings(auth_token="t", db_path=tmp_path / "c.db"))
    with TestClient(app, headers={"Authorization": "Bearer t"}) as made:
        made.seen = seen
        yield made


def _agent(client: TestClient, name: str) -> str:
    return client.post("/api/agents", json={"name": name}).json()["id"]


def test_a_group_is_made_by_its_first_message(client: TestClient):
    a, b = _agent(client, "Secretary"), _agent(client, "Analyst")
    r = client.post("/api/chat", json={"message": "@everyone hi", "members": [a, b]})
    assert r.status_code == 200
    metas = _events(r.text, "meta")
    assert [m["agent_id"] for m in metas] == [a, b]
    assert client.seen == [
        {"agent": "Secretary", "reply_only": False},
        {"agent": "Analyst", "reply_only": True},
    ]

    sid = _events(r.text, "session")[0]["session_id"]
    listed = next(s for s in client.get("/api/sessions").json()["sessions"] if s["id"] == sid)
    assert listed["members"] == [a, b]
    assert listed["preview"] == "Analyst here"

    opened = client.get(f"/api/sessions/{sid}").json()
    assert opened["session"]["members"] == [a, b]
    assert [m.get("agent_id") for m in opened["messages"]] == [None, a, b]


def test_without_a_mention_the_last_speaker_answers(client: TestClient):
    a, b = _agent(client, "Secretary"), _agent(client, "Analyst")
    r = client.post("/api/chat", json={"message": "@analyst numbers?", "members": [a, b]})
    sid = _events(r.text, "session")[0]["session_id"]
    r = client.post("/api/chat", json={"message": "and last year?", "session_id": sid})
    assert [m["agent_id"] for m in _events(r.text, "meta")] == [b]
    r = client.post("/api/chat", json={"message": "book it", "session_id": sid, "reply_as": a})
    assert [m["agent_id"] for m in _events(r.text, "meta")] == [a]


def test_an_unknown_member_is_refused_before_anything_is_made(client: TestClient):
    a = _agent(client, "Secretary")
    r = client.post("/api/chat", json={"message": "hi", "members": [a, "nope"]})
    assert r.status_code == 404
    assert client.get("/api/sessions").json()["sessions"] == []


def test_members_can_be_changed_and_the_group_ended(client: TestClient):
    a, b, c = (_agent(client, n) for n in ("Secretary", "Analyst", "Writer"))
    r = client.post("/api/chat", json={"message": "hi", "members": [a, b]})
    sid = _events(r.text, "session")[0]["session_id"]
    assert client.put(f"/api/sessions/{sid}/members", json={"agent_ids": [a, b, c]}).json()["members"] == [a, b, c]
    assert client.get(f"/api/sessions/{sid}").json()["session"]["members"] == [a, b, c]
    # Down to one: an ordinary conversation with that agent.
    client.put(f"/api/sessions/{sid}/members", json={"agent_ids": [c]})
    session = client.get(f"/api/sessions/{sid}").json()["session"]
    assert session["members"] == [] and session["agent_id"] == c


def test_a_one_to_one_chat_is_unchanged(client: TestClient):
    a = _agent(client, "Secretary")
    r = client.post("/api/chat", json={"message": "hi", "agent_id": a})
    assert [m["agent_id"] for m in _events(r.text, "meta")] == [a]
    assert client.seen == [{"agent": "Secretary", "reply_only": False}]
    listed = client.get("/api/sessions").json()["sessions"][0]
    assert listed["members"] == [] and listed["agent_id"] == a
