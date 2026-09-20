"""Agents: the store, how the orchestrator applies one, and the HTTP surface."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.db import Database
from app.main import create_app
from app.orchestrator import Orchestrator
from app.skills.skill import Skill
from app.skills.registry import Registry
from app.store import Store


@pytest.fixture
def store(tmp_path: Path) -> Store:
    return Store(Database(tmp_path / "agents.db"))


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    settings = Settings(db_path=tmp_path / "agents_api.db", auth_token="test_token")
    app = create_app(settings)
    return TestClient(app, headers={"Authorization": "Bearer test_token"})


class _Echo(Skill):
    def __init__(self, name: str) -> None:
        super().__init__(name=name, description=name)

    async def use(self, **kwargs) -> str:
        return f"ran {self.name}"


def _orchestrator(store: Store, registry: Registry) -> Orchestrator:
    settings = type(
        "S",
        (),
        {
            "system_preamble": "You are Courier.",
            "context_tokens": 8192,
            "reply_tokens": 1024,
            "ollama_think": "medium",
            "memory_max_facts": 20,
            "memory_fact_chars": 200,
        },
    )()
    return Orchestrator(settings, store, router=None, registry=registry)


# -- store --------------------------------------------------------------------


def test_agent_crud_and_assignment(store: Store):
    agent = store.create_agent(
        "Researcher", instructions="Cite sources.", skills=["web_search"]
    )
    assert store.get_agent(agent.id).name == "Researcher"

    sid = store.create_session()["id"]
    store.set_session_agent(sid, agent.id)
    assert store.session_agent(sid).id == agent.id

    # Deleting the agent leaves the conversation, unassigned.
    store.delete_agent(agent.id)
    assert store.session_agent(sid) is None
    assert store.get_session(sid) is not None


def test_skills_none_all_and_empty_are_distinct(store: Store):
    all_skills = store.create_agent("A")
    none_skills = store.create_agent("B", skills=[])
    some = store.create_agent("C", skills=["recall"])
    assert all_skills.parsed_skills() is None
    assert none_skills.parsed_skills() == []
    assert some.parsed_skills() == ["recall"]


def test_update_clears_only_what_is_named(store: Store):
    agent = store.create_agent("A", instructions="keep", skills=["recall"])
    # Send skills explicitly None to reset to "all", leave instructions alone.
    updated = store.update_agent(agent.id, {"skills": None})
    assert updated.parsed_skills() is None
    assert updated.instructions == "keep"


# -- orchestrator -------------------------------------------------------------


def test_agent_instructions_go_into_the_system_prompt(store: Store):
    orch = _orchestrator(store, Registry())
    sid = store.create_session()["id"]

    prompt_before, _ = orch.build_system_prompt(sid)
    assert "Cite every claim." not in prompt_before

    agent = store.create_agent("Researcher", instructions="Cite every claim.")
    store.set_session_agent(sid, agent.id)

    prompt_after, _ = orch.build_system_prompt(sid)
    assert prompt_after.startswith("You are Courier.")
    assert "Cite every claim." in prompt_after


def test_skill_schemas_narrow_to_the_agents_subset(store: Store):
    registry = Registry()
    for name in ("web_search", "recall", "read_file"):
        registry.register(_Echo(name))
    orch = _orchestrator(store, registry)

    # No agent: every enabled skill is offered.
    everything = {s["name"] for s in orch._skill_schemas()}
    assert everything == {"web_search", "recall", "read_file"}

    # A subset: only those.
    subset = {s["name"] for s in orch._skill_schemas({"recall"})}
    assert subset == {"recall"}

    # An empty subset collapses to None -- no tools offered at all.
    assert orch._skill_schemas(set()) is None


# -- HTTP ---------------------------------------------------------------------


def test_agent_rest_lifecycle(client: TestClient):
    created = client.post(
        "/api/agents",
        json={"name": "Coder", "instructions": "Write tests first.", "skills": ["recall"]},
    )
    assert created.status_code == 200
    agent = created.json()
    assert agent["skills"] == ["recall"]
    agent_id = agent["id"]

    # Assign it to a session.
    sid = client.post("/api/sessions").json()["id"]
    assigned = client.put(f"/api/sessions/{sid}/agent", json={"agent_id": agent_id})
    assert assigned.status_code == 200
    assert client.get(f"/api/sessions/{sid}").json()["session"]["agent_id"] == agent_id

    # Clear skills back to "all" by sending null explicitly.
    patched = client.patch(f"/api/agents/{agent_id}", json={"skills": None})
    assert patched.status_code == 200
    assert patched.json()["skills"] is None
    assert patched.json()["instructions"] == "Write tests first."

    # Delete leaves the session, unassigned.
    assert client.delete(f"/api/agents/{agent_id}").status_code == 200
    assert client.get(f"/api/sessions/{sid}").json()["session"]["agent_id"] is None


def test_agent_routes_404_on_missing(client: TestClient):
    assert client.patch("/api/agents/agt_nope", json={"name": "x"}).status_code == 404
    assert client.delete("/api/agents/agt_nope").status_code == 404
    sid = client.post("/api/sessions").json()["id"]
    assert (
        client.put(f"/api/sessions/{sid}/agent", json={"agent_id": "agt_nope"}).status_code
        == 404
    )
