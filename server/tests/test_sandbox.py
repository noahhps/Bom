"""The local sandbox skills: gating, execution, limits, and env hygiene."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from app.config import Settings
from app.skills.sandbox import RunPython, RunShell


def _settings(tmp_path: Path, **over) -> Settings:
    base = dict(
        sandbox_enabled=True,
        sandbox_dir=tmp_path / "box",
        sandbox_timeout=10,
        sandbox_output_chars=6_000,
    )
    base.update(over)
    return Settings(**base)


def test_off_by_default_and_gated_by_the_switch(tmp_path: Path):
    off = Settings(sandbox_enabled=False, sandbox_dir=tmp_path / "box")
    assert RunShell(off).available is False
    assert RunPython(off).available is False
    on = _settings(tmp_path)
    assert RunShell(on).available is True


@pytest.mark.asyncio
async def test_run_python_returns_what_it_printed(tmp_path: Path):
    skill = RunPython(_settings(tmp_path))
    out = await skill.use(code="print(6 * 7)")
    assert out.strip() == "42"


@pytest.mark.asyncio
async def test_run_python_reports_a_failing_exit(tmp_path: Path):
    skill = RunPython(_settings(tmp_path))
    out = await skill.use(code="import sys; print('partial'); sys.exit(3)")
    assert "status 3" in out
    assert "partial" in out


@pytest.mark.asyncio
async def test_run_shell_runs_in_the_scratch_dir(tmp_path: Path):
    settings = _settings(tmp_path)
    skill = RunShell(settings)
    # A file written by the command lands in the sandbox directory.
    out = await skill.use(command="echo hi > note.txt && cat note.txt")
    assert "hi" in out
    assert (settings.sandbox_dir / "note.txt").exists()


@pytest.mark.asyncio
async def test_a_runaway_command_times_out(tmp_path: Path):
    skill = RunPython(_settings(tmp_path, sandbox_timeout=1))
    out = await skill.use(code="import time; time.sleep(5)")
    assert "Timed out" in out


@pytest.mark.asyncio
async def test_output_is_capped(tmp_path: Path):
    skill = RunPython(_settings(tmp_path, sandbox_output_chars=100))
    out = await skill.use(code="print('x' * 5000)")
    assert "output cut at 100 characters" in out
    assert len(out) < 400


@pytest.mark.asyncio
async def test_app_secrets_are_stripped_from_the_environment(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-should-not-leak")
    skill = RunPython(_settings(tmp_path))
    out = await skill.use(code="import os; print(os.environ.get('ANTHROPIC_API_KEY'))")
    assert "sk-should-not-leak" not in out
    assert out.strip() == "None"


@pytest.mark.asyncio
async def test_empty_input_is_refused_without_running(tmp_path: Path):
    assert "command" in (await RunShell(_settings(tmp_path)).use(command="  ")).lower()
    assert "python" in (await RunPython(_settings(tmp_path)).use(code="")).lower()
