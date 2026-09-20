"""Configuration. Environment variables only -- there is one deployment.

Everything has a working default so `python -m app` runs with no setup at all.
"""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, cast

REPO_ROOT = Path(__file__).resolve().parents[2]

ThinkingLevel = Literal["low", "medium", "high"]
_THINKING_LEVELS = frozenset(("low", "medium", "high"))


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default).strip()


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return int(raw)

def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return float(raw)


def _env_paths(name: str, default: list[Path]) -> tuple[Path, ...]:
    """A `os.pathsep`-separated list of directories, expanded and de-duplicated.

    Missing directories are dropped rather than raising: a machine without a
    ~/Pictures is not misconfigured, and a skill that refuses to start because
    one of four defaults is absent would be its own bug report.
    """
    raw = os.environ.get(name)
    candidates = (
        [Path(p) for p in raw.split(os.pathsep) if p.strip()] if raw and raw.strip() else default
    )
    seen: dict[Path, None] = {}
    for path in candidates:
        try:
            resolved = path.expanduser().resolve()
        except OSError:
            continue
        if resolved.is_dir():
            seen[resolved] = None
    return tuple(seen)


def _env_thinking_level(name: str, default: ThinkingLevel) -> ThinkingLevel:
    """Read the reasoning effort understood by gpt-oss via Ollama."""
    value = _env(name, default).lower()
    if value not in _THINKING_LEVELS:
        choices = ", ".join(sorted(_THINKING_LEVELS))
        raise ValueError(f"{name} must be one of: {choices}")
    return cast(ThinkingLevel, value)


@dataclass(frozen=True)
class Settings:
    # --- transport -------------------------------------------------------
    # Used verbatim. Loopback by default, so nothing off this machine can
    # reach the API until this says otherwise; a LAN address (or 0.0.0.0)
    # opens it to that network, with the bearer token as the only thing in
    # front of it. Read the note on the token before widening this.
    bind_host: str = field(default_factory=lambda: _env("BIND_HOST", "127.0.0.1"))
    bind_port: int = field(default_factory=lambda: _env_int("BIND_PORT", 8080))

    # --- auth ------------------------------------------------------------
    # The perimeter. Generated and persisted on first run.
    auth_token: str = field(default_factory=lambda: _env("AUTH_TOKEN", ""))

    # --- storage ---------------------------------------------------------
    db_path: Path = field(
        default_factory=lambda: Path(_env("DB_PATH", str(REPO_ROOT / "data" / "chat.db")))
    )
    # The built client, not the source: `npm run build` in client/ produces it.
    client_dir: Path = field(
        default_factory=lambda: Path(_env("CLIENT_DIR", str(REPO_ROOT / "client" / "dist")))
    )

    # --- inference -------------------------------------------------------
    ollama_url: str = field(default_factory=lambda: _env("OLLAMA_URL", "http://127.0.0.1:11434"))
    ollama_model: str = field(default_factory=lambda: _env("OLLAMA_MODEL", "qwen3.6:35b-a3b"))
    # gpt-oss uses a three-level reasoning effort, not a boolean. This is the
    # fallback when an API caller does not choose a level of its own.
    ollama_think: ThinkingLevel = field(
        default_factory=lambda: _env_thinking_level("OLLAMA_THINK", "medium")
    )

    # --- memory ----------------------------------------------------------
    # The encoder behind recall. Pulled separately from the chat model
    # (`ollama pull nomic-embed-text`); if it is missing, chunks stay
    # unembedded and search falls back to keywords alone.
    #
    # Changing this does not migrate anything. Vectors from different encoders
    # are not comparable, so `chunks.model` records what made each row and
    # search filters on it -- an old row simply stops being found until it is
    # re-embedded.
    embed_model: str = field(default_factory=lambda: _env("EMBED_MODEL", "nomic-embed-text"))

    # How close a chunk must be to count as a match at all, as cosine
    # similarity between normalised vectors.
    #
    # Encoder-dependent, and worth checking once against your own: ask
    # something the history definitely does not cover and print the scores. If
    # anything comes back, this is too low. Too high is the safe direction --
    # recall falls back to keywords rather than inventing relevance.
    memory_min_similarity: float = field(
        default_factory=lambda: _env_float("MEMORY_MIN_SIMILARITY", 0.35)
    )

    # How many curated facts may ride in the system prompt. They are prepended
    # to every request, on the same budget the conversation is competing for,
    # so this is a cap on how much memory is allowed to cost per turn.
    memory_max_facts: int = field(default_factory=lambda: _env_int("MEMORY_MAX_FACTS", 40))
    # And how long any one of them may be. A fact is a sentence; anything
    # longer is a note that belongs in the history, where recall can find it.
    memory_fact_chars: int = field(default_factory=lambda: _env_int("MEMORY_FACT_CHARS", 200))

    # Turns between curation passes. The pass is a whole extra generation, so
    # running it every turn doubles the work the GPU does for something nobody
    # is waiting on. 0 switches it off entirely.
    memory_extract_every: int = field(
        default_factory=lambda: _env_int("MEMORY_EXTRACT_EVERY", 5)
    )

    # --- web search ------------------------------------------------------
    # The one thing here that leaves the machine. Empty by default, and the
    # skill is not registered at all without it -- a capability the model is
    # told about but cannot use is worse than one it never hears of.
    #
    # A Brave Search key (free tier, no card) unless SEARCH_ENDPOINT points
    # somewhere else that answers in the same shape.
    search_api_key: str = field(default_factory=lambda: _env("SEARCH_API_KEY", ""))
    # Where a key pasted into the Skills page is kept. Beside the bearer token,
    # for the same reason: it is a secret that has to survive a restart, and
    # `data/` is already the directory nothing commits.
    search_key_path: Path = field(
        default_factory=lambda: Path(
            _env("SEARCH_KEY_PATH", str(REPO_ROOT / "data" / "search_key"))
        )
    )
    search_endpoint: str = field(default_factory=lambda: _env("SEARCH_ENDPOINT", ""))

    # --- openrouter ------------------------------------------------------
    # The second thing that leaves the machine, and the first that answers
    # with a model. Empty by default: unconfigured, it is listed in the picker
    # as somewhere to sign in rather than offered as somewhere to route.
    #
    # A key can arrive three ways -- this variable, the Settings page, or the
    # sign-in flow -- and the last two both end up in `openrouter_key_path`.
    # The environment still wins at boot, for the reason the search key gives:
    # someone who exported it meant it.
    openrouter_api_key: str = field(default_factory=lambda: _env("OPENROUTER_API_KEY", ""))
    openrouter_key_path: Path = field(
        default_factory=lambda: Path(
            _env("OPENROUTER_KEY_PATH", str(REPO_ROOT / "data" / "openrouter_key"))
        )
    )
    # `openrouter/auto` lets OpenRouter choose per prompt, which is the only
    # default that is right before anyone has picked. The picker overrides it,
    # and what it picks is stored in the database rather than here.
    openrouter_model: str = field(
        default_factory=lambda: _env("OPENROUTER_MODEL", "openrouter/auto")
    )
    openrouter_url: str = field(
        default_factory=lambda: _env("OPENROUTER_URL", "https://openrouter.ai/api/v1")
    )

    # --- the device ------------------------------------------------------
    # Which directories the file skills may look inside, as a list separated by
    # the platform's path separator. Everything outside them is invisible: the
    # skills resolve a path and then check it is under one of these, so a
    # symlink or a `..` cannot walk out.
    #
    # Named roots rather than "the home directory" on purpose. The home
    # directory contains ~/.ssh, ~/.aws, browser profiles and every token this
    # machine has ever been given, and a model that can read one file there can
    # read all of them. These four are where a person's own documents live.
    #
    # On macOS, Desktop/Documents/Downloads are themselves gated by the system
    # ("Files and Folders"), so the first read prompts and the reader decides
    # again at that level. That is a feature, not an obstacle.
    device_roots: tuple[Path, ...] = field(
        default_factory=lambda: _env_paths(
            "DEVICE_ROOTS",
            [Path.home() / name for name in ("Desktop", "Documents", "Downloads", "Pictures")],
        )
    )
    # A cap on what one read can put into the window. A file is not a document
    # the reader chose to attach -- the model picked it -- so it is trimmed
    # harder, and the skill says how much it left behind.
    device_read_chars: int = field(default_factory=lambda: _env_int("DEVICE_READ_CHARS", 12_000))

    # --- the sandbox -----------------------------------------------------
    # A local "computer": the model can run a shell command or a Python snippet
    # in a scratch directory. This is the single most powerful thing Courier can
    # be given, and the most dangerous, so it is OFF unless SANDBOX_ENABLED is
    # set -- an unset default that could execute code would be a footgun waiting
    # for a hallucinated `rm`.
    #
    # Be honest about what the confinement is: `sandbox_dir` is the working
    # directory, not a jail. Commands run as the same user as the server, with
    # its filesystem and its network -- `cd /` and a shell command reaches
    # whatever that user can. The real gate is the approval prompt (the exact
    # command is shown before it runs) plus this switch being a deliberate
    # choice, not the directory. Enable it on a machine where you would run the
    # command yourself, and leave "Ask before running a skill" on.
    sandbox_enabled: bool = field(
        default_factory=lambda: _env("SANDBOX_ENABLED", "").lower() in ("1", "true", "yes", "on")
    )
    sandbox_dir: Path = field(
        default_factory=lambda: Path(
            _env("SANDBOX_DIR", str(REPO_ROOT / "data" / "sandbox"))
        )
    )
    # How long one command may run before it is killed, in seconds. A local
    # model that writes `while True` should cost a wait, not the whole session.
    sandbox_timeout: int = field(default_factory=lambda: _env_int("SANDBOX_TIMEOUT", 30))
    # A cap on what one run puts back into the window, trimmed further by the
    # turn loop. Output past this is cut with a note.
    sandbox_output_chars: int = field(
        default_factory=lambda: _env_int("SANDBOX_OUTPUT_CHARS", 6_000)
    )

    # Rough working-context budget in tokens. The window builder trims to fit;
    # real compaction (summarise the middle, keep head and tail) is phase 5.
    context_tokens: int = field(default_factory=lambda: _env_int("CONTEXT_TOKENS", 32768))
    # Headroom reserved for the reply so a full window can't crowd it out.
    reply_tokens: int = field(default_factory=lambda: _env_int("REPLY_TOKENS", 2048))

    # How many times a turn may go back to the model after running skills before
    # it is cut off. The circuit-breaker on a local model that loops on
    # near-identical calls, and a ceiling on how much a single turn can grow the
    # window: each round appends a tool result, so a very high number can
    # overflow CONTEXT_TOKENS and force the reduced-context retry, which throws
    # away the earlier work. The Continue button in the client is the deliberate
    # extension past this, so it does not need to cover the worst case alone --
    # 16 is a sane default; raise CONTEXT_TOKENS alongside it if you raise this.
    max_tool_rounds: int = field(default_factory=lambda: _env_int("MAX_TOOL_ROUNDS", 16))

    # Carry a compact recap of each past turn's working -- the tools it called
    # with a trimmed line of each result, and the tail of its reasoning -- into
    # later turns. The turn loop feeds tool results and thinking to the model
    # live, but only the final answer is stored as the message body, so without
    # this the model sees its own conclusions on the next turn (or after a
    # Continue) with no memory of what it read to reach them. Off (CARRY_WORKING
    # unset to 0) falls back to replaying the answer text alone.
    carry_working: bool = field(
        default_factory=lambda: _env("CARRY_WORKING", "1").lower() not in ("0", "false", "no", "off")
    )

    system_preamble: str = field(
        default_factory=lambda: _env(
            "SYSTEM_PREAMBLE",
            # Kept deliberately short: this is the cacheable prefix and it is
            # prepended to every request, so each sentence is paid for on every
            # turn of every conversation forever.
            #
            # It says nothing about which skills exist. That list reaches the
            # model as the `tools` array, which Ollama renders into the prompt
            # using the format the model was trained on -- naming them here as
            # well would duplicate it, cost tokens twice, and go stale the
            # moment a skill is added or switched off. It once said "you have
            # access to a clock tool" while no tools were being sent, and the
            # model spent every turn hunting for a tool it could not see.
            "You are Courier, a personal assistant that runs on the user's own "
            "hardware -- their machine, their data, none of it leaving unless a "
            "tool they switched on sends it. You work for the person in front "
            "of you, not a service behind you. "
            # Scoped to conversation on purpose. This preamble is prepended to
            # every request, so an unqualified "be brief" was also in force
            # while the model wrote documents -- which is how a report came
            # back as four one-line bullets.
            "In conversation, be direct and concrete. Lead with the answer, "
            "then the reasoning if it is needed; skip the preamble and the "
            "flattery, and do not pad. If you get something wrong, fix it in a "
            "sentence rather than apologising at length. "
            "Longer work is the opposite. When you are asked for a document, a "
            "plan, an essay, code, or anything the user will keep or build on, "
            "write it out in full -- a heading with one thin line under it "
            "reads as unfinished. Brevity is a courtesy in chat, not a virtue "
            "in a deliverable. "
            "Match the user's language, tone, depth and formality. Use markdown "
            "when it helps them scan, plain prose when it does not. "
            "Be honest before you are helpful. Say when you do not know, and "
            "say what would settle it. Never invent a fact, a citation, a "
            "number or a quote to fill a gap. If the user is wrong, say so "
            "plainly and explain why -- agreeing to be pleasant is a way of "
            "being useless. "
            "Reach for a tool whenever it would beat your own memory: anything "
            "about the present moment, the user's files, or your past "
            "conversations is worth looking up rather than guessing at. Report "
            "what the tool actually returned, not what you expected, and do not "
            "narrate the machinery unless asked. If a tool fails or is refused, "
            "say so and what it means -- never answer as though it had worked. "
            "Any date or time you are handed is when this conversation "
            "started, not the current moment; use a tool if exactly when "
            "matters. Write dates as DD-MM-YYYY.",
        )
    )


def read_secret(path: Path) -> str:
    """The saved secret, or empty. Never raises -- a missing file is the normal
    state before anyone has pasted one in."""
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def write_secret(path: Path, value: str) -> None:
    """Persist or clear a secret. Empty clears the file rather than writing a
    blank one, so the state on disk matches the state in memory."""
    path.parent.mkdir(parents=True, exist_ok=True)
    value = (value or "").strip()
    if not value:
        path.unlink(missing_ok=True)
        return
    path.write_text(value, encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass  # Windows; ACLs are the user's problem there


def load_settings() -> Settings:
    settings = Settings()
    if not settings.auth_token:
        token = _load_or_create_token(settings.db_path.parent / "token")
        settings = Settings(**{**settings.__dict__, "auth_token": token})
        
    settings.db_path.parent.mkdir(parents=True, exist_ok=True)
    # The environment wins: someone who exported SEARCH_API_KEY meant it, and
    # a stale file should not quietly override this run.
    if not settings.search_api_key:
        saved = read_secret(settings.search_key_path)
        if saved:
            settings = Settings(**{**settings.__dict__, "search_api_key": saved})
    if not settings.openrouter_api_key:
        saved = read_secret(settings.openrouter_key_path)
        if saved:
            settings = Settings(**{**settings.__dict__, "openrouter_api_key": saved})
    return settings


# Deliberately excludes 0/O, 1/l/I -- this gets typed on a phone keyboard once
# per device, and a misread character is the whole experience.
_TOKEN_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"


def _load_or_create_token(path: Path) -> str:
    """Keep the bearer token on disk so it survives restarts.

    Regenerating it every boot would log the phone out roughly weekly, which is
    exactly the friction that gets a personal tool abandoned.

    14 characters from a 31-symbol alphabet is ~69 bits: short enough to type
    from a sticky note, far beyond guessing at any rate a network allows.

    It is the only thing standing in front of the API, so it carries more
    weight the further BIND_HOST reaches. On loopback it is a formality; on an
    address other machines can dial it is the whole perimeter, which is what
    TOKEN_LENGTH is there for.
    """
    if path.exists():
        existing = path.read_text(encoding="utf-8").strip()
        if existing:
            return existing
    path.parent.mkdir(parents=True, exist_ok=True)
    length = _env_int("TOKEN_LENGTH", 14)
    token = "".join(secrets.choice(_TOKEN_ALPHABET) for _ in range(length))
    path.write_text(token, encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass  # Windows; ACLs are the user's problem there
    return token
