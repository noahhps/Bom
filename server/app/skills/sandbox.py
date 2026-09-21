"""A local computer, as two skills: run a shell command, run Python.

This is the most powerful thing Bom hands the model and the most dangerous,
so three things are true of it by construction:

* it is **off** unless `SANDBOX_ENABLED` is set -- an unconfigured capability
  that could run code is a footgun, so an unset machine never offers it;
* every call goes through the **approval gate** like any other skill, and the
  exact command is shown before it runs (see `PermissionAsk`), so "run a shell
  command" is never the decision -- `rm -rf ~` is;
* it runs in a **scratch directory** (`settings.sandbox_dir`), which is where
  work lands and relative paths resolve.

Be honest about the last one: the directory is a working directory, not a jail.
A command runs as the same user as the server, with that user's filesystem and
network, and `cd /` walks out of the scratch dir like anywhere else. The
confinement that matters is the switch being a deliberate choice and the
approval prompt in front of each run -- not the folder. This is the local,
single-machine answer to the "computer" a GrokBot or Manus agent drives in the
cloud, and it makes the same trade: real capability for the cost of trusting
what you approve.

The app's own secrets are stripped from the environment the command sees, so a
snippet cannot print `ANTHROPIC_API_KEY` back out of `os.environ`. That is
hygiene, not a security boundary -- a command that can read the filesystem can
read the key file too.
"""

from __future__ import annotations

import asyncio
import os
import sys

from .skill import Skill

# Environment names the app uses for its own secrets. Dropped from what a
# command inherits so the assistant's keys are not one `env` away from the
# model. Not a boundary -- see the module docstring -- just the obvious hygiene.
_STRIPPED_ENV = {
    "AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY",
    "SEARCH_API_KEY",
    "TOKEN_LENGTH",
}


def _clean_env() -> dict[str, str]:
    return {k: v for k, v in os.environ.items() if k not in _STRIPPED_ENV}


def _format(stdout: str, code: int | None, limit: int, *, timed_out: bool, seconds: int) -> str:
    """One run's result as text the model reads.

    stdout and stderr are already merged, because the model wants "what
    happened" in order, not two streams to reconcile -- and a program that
    prints progress to stderr and its answer to stdout reads correctly this way.
    """
    if timed_out:
        head = f"Timed out after {seconds}s and was killed. Partial output:\n"
    elif code == 0:
        head = ""
    else:
        head = f"Exited with status {code}.\n"

    body = stdout.rstrip("\n")
    if len(body) > limit:
        body = body[:limit] + f"\n… output cut at {limit} characters."
    if not body:
        body = "(no output)"
    return (head + body) if head else body


class _Sandboxed(Skill):
    """Shared construction and the run itself for the two sandbox skills."""

    def __init__(self, *, name: str, description: str, parameters, settings) -> None:
        super().__init__(
            name=name,
            description=description,
            parameters=parameters,
            requires="SANDBOX_ENABLED=1",
        )
        self.settings = settings

    @property
    def available(self) -> bool:
        return bool(self.settings.sandbox_enabled)

    async def _run(self, argv: list[str] | None = None, *, shell: str | None = None) -> str:
        # Made on first use rather than at boot: an unenabled sandbox should
        # leave nothing behind, and the directory is cheap to create when the
        # first approved command actually needs it.
        workdir = self.settings.sandbox_dir
        try:
            workdir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            return f"Could not prepare the sandbox directory {workdir}: {exc}"

        timeout = max(1, int(self.settings.sandbox_timeout))
        try:
            if shell is not None:
                proc = await asyncio.create_subprocess_shell(
                    shell,
                    cwd=str(workdir),
                    env=_clean_env(),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                )
            else:
                proc = await asyncio.create_subprocess_exec(
                    *argv,
                    cwd=str(workdir),
                    env=_clean_env(),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                )
        except (OSError, ValueError) as exc:
            return f"Could not start the command: {exc}"

        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            # Reap it so the killed process is not left as a zombie, and recover
            # whatever it had already written.
            try:
                out, _ = await proc.communicate()
            except Exception:
                out = b""
            return _format(
                out.decode("utf-8", "replace"),
                None,
                self.settings.sandbox_output_chars,
                timed_out=True,
                seconds=timeout,
            )

        return _format(
            out.decode("utf-8", "replace"),
            proc.returncode,
            self.settings.sandbox_output_chars,
            timed_out=False,
            seconds=timeout,
        )


class RunShell(_Sandboxed):
    def __init__(self, settings) -> None:
        super().__init__(
            name="run_shell",
            description=(
                "Run a shell command on the user's machine and return its "
                "output. Use for real work the answer depends on -- inspecting "
                "files you created, running a build, using a CLI tool. It runs "
                "in a scratch directory, as the user, so relative paths land "
                "there. The user approves each command before it runs. Prefer "
                "run_python for anything that is really a program."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The shell command line to run.",
                    }
                },
                "required": ["command"],
            },
            settings=settings,
        )

    async def use(self, command: str) -> str:
        line = (command or "").strip()
        if not line:
            return "Give me a command to run."
        return await self._run(shell=line)


class RunPython(_Sandboxed):
    def __init__(self, settings) -> None:
        super().__init__(
            name="run_python",
            description=(
                "Run a snippet of Python and return everything it printed, plus "
                "its exit status if it failed. Use for calculation, parsing, "
                "quick data work -- anything you would otherwise try to do in "
                "your head and could get wrong. It runs in a scratch directory "
                "as the user; print what you want to see back. The user approves "
                "each run."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "code": {
                        "type": "string",
                        "description": "Python source to execute. Print results to see them.",
                    }
                },
                "required": ["code"],
            },
            settings=settings,
        )

    async def use(self, code: str) -> str:
        source = code or ""
        if not source.strip():
            return "Give me some Python to run."
        # `-I` isolated mode: ignore the user's PYTHONPATH and site customisation
        # so a run is reproducible and does not accidentally import something
        # from the server's own tree. `-c` rather than a temp file keeps the
        # scratch directory for the code's own outputs, not our plumbing.
        return await self._run([sys.executable, "-I", "-c", source])
