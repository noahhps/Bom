"""Enterprise mode: the same Bom, with its limits sized for company work.

Bom's defaults are sized for one person on one machine: a 64k window a laptop's
memory can hold, tool results cut to a few pages, a turn stopped after two
dozen rounds of skills, and a long conversation compacted early. Those are the
right limits for a local model sharing a GPU with everything else, and the
wrong ones for a team pointing Bom at a large codebase, a cloud model with a
million-token window, and conversations that run for days.

Enterprise mode is one switch (Settings > Enterprise mode) that lays a larger
profile over the environment's settings while it is on:

* **the window** grows to what the model can actually hold -- the local
  budget to 128k (still capped at what the model was trained on), the cloud
  one to 1M (capped at the model's own window), with room for long replies;
* **tools see more**: larger reads, command output and search listings, and
  more rounds before a turn is stopped;
* **compaction** starts later and keeps more of the conversation verbatim,
  with a longer, more detailed summary of what it folds away;
* **caching** holds the prompt for an hour rather than five minutes, because
  turns in a working day are minutes apart and re-reading a long context at
  full price is the largest cost there is.

What it does *not* touch is anything that keeps the machine safe: the sandbox
switch, the approval prompt, the folders a project may be opened from, and the
secrets kept out of every shell all stand exactly as they were.

Every value can be tuned with an ENTERPRISE_<NAME> environment variable
(ENTERPRISE_CONTEXT_TOKENS=262144, ENTERPRISE_COMPACT_AT=0.9, ...). A limit the
environment already set higher than the profile is never lowered by it.
"""

from __future__ import annotations

import os
from typing import Any

#: Where the switch is kept, in the `app_settings` table the memory and
#: approval switches share.
ENTERPRISE_KEY = "enterprise.mode"
ENTERPRISE_DEFAULTS = {ENTERPRISE_KEY: False}

#: The profile: each setting it raises, and the value it raises it to.
#: Numbers are floors -- `max(environment, profile)` -- except the compaction
#: fractions, which are the profile's own choice either way.
PROFILE: dict[str, Any] = {
    # The window.
    "context_tokens": 131_072,
    "cloud_context_tokens": 1_000_000,
    "reply_tokens": 32_768,
    "cloud_max_tokens": 128_000,
    # What one result may put back into it.
    "result_chars": 50_000,
    "code_output_chars": 120_000,
    "canvas_read_chars": 200_000,
    "device_read_chars": 60_000,
    "sandbox_output_chars": 30_000,
    "code_glob_limit": 1_000,
    "code_ls_limit": 2_000,
    # How long a turn may work.
    "max_tool_rounds": 100,
    "code_timeout": 300,
    "code_timeout_max": 3_600,
    "sandbox_timeout": 120,
    # What earlier turns carry forward.
    "window_images": 12,
    "carried_result_chars": 1_200,
    "carried_reasoning_chars": 2_000,
    # Compaction: later, keeping more, with a fuller summary.
    "compact_at": 0.85,
    "compact_keep": 0.4,
    "compact_summary_tokens": 4_000,
    # Caching.
    "cache_ttl": "1h",
    "ollama_keep_alive": "1h",
}

#: Taken as the profile gives them rather than as a floor over the
#: environment's value: a fraction is a choice, not a limit to be raised.
_CHOSEN = {"compact_at", "compact_keep", "cache_ttl", "ollama_keep_alive"}

#: What the Settings screen shows side by side, in this order, with the label
#: a person reads. Only the limits a reader would recognise; the rest follow.
SHOWN = (
    ("context_tokens", "Local context window", "tokens"),
    ("cloud_context_tokens", "Cloud context window", "tokens"),
    ("reply_tokens", "Room kept for a reply", "tokens"),
    ("max_tool_rounds", "Tool rounds per turn", "rounds"),
    ("result_chars", "Tool result size", "characters"),
    ("code_output_chars", "Code read and command output", "characters"),
    ("code_timeout_max", "Longest command", "seconds"),
    ("compact_at", "Compact history at", "of the window"),
    ("compact_keep", "Kept word for word after compacting", "of the window"),
    ("compact_summary_tokens", "Summary length", "tokens"),
    ("cache_ttl", "Prompt cache kept for", ""),
)


def _from_env(name: str, default: Any) -> Any:
    raw = os.environ.get(f"ENTERPRISE_{name.upper()}")
    if raw is None or not raw.strip():
        return default
    raw = raw.strip()
    if isinstance(default, bool):
        return raw.lower() in ("1", "true", "yes", "on")
    if isinstance(default, int):
        return int(raw)
    if isinstance(default, float):
        return float(raw)
    return raw


def enterprise_profile(base: Any) -> dict[str, Any]:
    """The profile as it applies over `base`: environment overrides first,
    then never lower than what `base` already allows."""
    profile: dict[str, Any] = {}
    for name, default in PROFILE.items():
        value = _from_env(name, default)
        current = getattr(base, name, None)
        if (
            name not in _CHOSEN
            and isinstance(value, (int, float))
            and isinstance(current, (int, float))
            and not isinstance(current, bool)
        ):
            value = max(value, current)
        profile[name] = value
    return profile


def read_enterprise(store: Any) -> bool:
    try:
        return bool(store.get_settings(ENTERPRISE_DEFAULTS)[ENTERPRISE_KEY])
    except Exception:  # noqa: BLE001 -- a store without the table is standard mode
        return False


def enterprise_on(settings: Any) -> bool:
    """Whether `settings` is running the enterprise profile. False for plain
    settings objects, which is every test double and every one-liner."""
    return bool(getattr(settings, "enterprise", False))


class LiveSettings:
    """Settings as they stand right now.

    The environment's settings, with the enterprise profile laid over them
    while the switch is on. Handed to everything `create_app` builds in place
    of the frozen `Settings`, so a skill that reads `settings.result_chars`
    when it runs sees the limit in force at that moment -- the switch takes
    effect on the next call, with no restart and nothing rebuilt.

    The switch is read from the store once and then kept here; `set_enterprise`
    is the one way it changes, and writes through.
    """

    def __init__(self, base: Any, store: Any) -> None:
        object.__setattr__(self, "_base", base)
        object.__setattr__(self, "_store", store)
        object.__setattr__(self, "_on", read_enterprise(store))
        object.__setattr__(self, "_profile", enterprise_profile(base))

    @property
    def base(self) -> Any:
        return self._base

    @property
    def enterprise(self) -> bool:
        return self._on

    def set_enterprise(self, on: bool) -> None:
        self._store.set_settings({ENTERPRISE_KEY: bool(on)})
        object.__setattr__(self, "_on", bool(on))

    def standard(self, name: str) -> Any:
        return getattr(self._base, name, None)

    def profile(self, name: str) -> Any:
        return self._profile.get(name, getattr(self._base, name, None))

    def __getattr__(self, name: str) -> Any:
        # Only reached for names not on this object itself, which is every
        # setting: the profile's value while the switch is on, else the base.
        # Private and dunder names are never settings, and answering them
        # here would recurse before __init__ has run (copy, pickle).
        if name.startswith("_"):
            raise AttributeError(name)
        if self._on and name in self._profile:
            return self._profile[name]
        return getattr(self._base, name)

    def __setattr__(self, name: str, value: Any) -> None:
        raise AttributeError("settings are read-only; change the environment or the switch")


def describe(settings: Any) -> dict:
    """The switch and both sets of limits, for the Settings screen."""
    rows = []
    for name, label, unit in SHOWN:
        standard = settings.standard(name) if hasattr(settings, "standard") else getattr(settings, name, None)
        enterprise = settings.profile(name) if hasattr(settings, "profile") else PROFILE.get(name)
        rows.append({
            "name": name,
            "label": label,
            "unit": unit,
            "standard": standard,
            "enterprise": enterprise,
        })
    return {"enabled": enterprise_on(settings), "limits": rows}
