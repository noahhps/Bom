"""Local first, cloud only when local is unreachable.

Health is cached briefly so a burst of turns doesn't hammer Ollama's /api/tags,
but not so long that a restarted Ollama stays marked dead for minutes.

Three backends now rather than two, which makes the naming worth stating: the
wire vocabulary is `local`, `cloud` and `openrouter` -- what a caller asks for
-- while `provider.name` is `ollama`, `anthropic` and `openrouter`, which is
what answered. The first is the user's word and appears in the client; the
second is recorded on the message. `cloud` predates the third backend and stays
spelled that way because it is what the stored rows and the running client
already say.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from ..config import Settings
from .anthropic import AnthropicProvider
from .base import ModelProvider
from .ollama import OllamaProvider
from .openai_compat import OpenAICompatProvider
from .openrouter import OpenRouterProvider
from .presets import get_connection_preset

_HEALTH_TTL_SECONDS = 15.0

LOCAL = "local"
NETWORK = "network"
CLOUD = "cloud"
OPENROUTER = "openrouter"

# Where the network Ollama's address is kept in `app_settings`.
NETWORK_URL_SETTING = "ollama.network_url"

# The order auto walks when local is not answering. OpenRouter before Anthropic
# on purpose: it is only ever configured by someone doing so deliberately in
# this app, where ANTHROPIC_API_KEY is an environment variable that may be
# there for something else entirely.
#
# The network Ollama comes first of all: it is the user's own hardware on
# their own network, so falling back to it keeps a conversation off the
# internet when this machine's Ollama is down.
FALLBACK_ORDER = (NETWORK, OPENROUTER, CLOUD)

# Where a reordered fallback list is kept in `app_settings`, as a JSON list of
# provider ids. Connections not named in it follow the ones that are, in the
# order they were added.
FALLBACK_SETTING = "providers.fallback_order"

# Where a picked model is kept, per backend, in `app_settings`. Namespaced like
# the theme and the memory switches beside it, because that table is shared.
MODEL_SETTING_PREFIX = "model."


def model_setting_key(provider_id: str) -> str:
    return f"{MODEL_SETTING_PREFIX}{provider_id}"


@dataclass
class Route:
    provider: ModelProvider
    # "local" | "fallback" -- surfaced in the UI banner. It says whether this
    # was a fallback, not which one: with two cloud backends, *what* answered
    # is `provider.name`, which is unique per backend and is what the message
    # is stored with.
    reason: str


class ProviderRouter:
    def __init__(self, settings: Settings, *, network_url: str | None = None) -> None:
        self.local = OllamaProvider(
            settings.ollama_url,
            settings.ollama_model,
            embed_model=settings.embed_model,
            context_tokens=settings.context_tokens,
        )
        # Named apart from the local one because `provider.name` is what a
        # message is stored with, and "which Ollama answered" is worth keeping.
        self.network = OllamaProvider(
            network_url if network_url is not None else getattr(settings, "network_ollama_url", ""),
            settings.ollama_model,
            embed_model=settings.embed_model,
            context_tokens=settings.context_tokens,
            name="ollama-network",
        )
        # The cloud backends get their own, larger window: it costs nothing in
        # memory here, and each still caps it at what its model holds.
        cloud_window = getattr(settings, "cloud_context_tokens", 200_000)
        self.cloud = AnthropicProvider(
            max_tokens=getattr(settings, "cloud_max_tokens", 64_000),
            context_tokens=cloud_window,
        )
        self.openrouter = OpenRouterProvider(
            settings.openrouter_api_key,
            settings.openrouter_model,
            base_url=settings.openrouter_url,
            context_tokens=cloud_window,
        )
        # Connections to OpenAI-compatible services, by connection id -- the
        # id is also their provider id everywhere else (the picker, /api/chat's
        # `provider`, the fallback order). See load_connections.
        self.connections: dict[str, OpenAICompatProvider] = {}
        self._retired: list[OpenAICompatProvider] = []
        self.fallback_order: list[str] = list(FALLBACK_ORDER)
        self._settings = settings
        self._rebuild()
        self._last_check = 0.0
        self._last_healthy = True
        self.apply_limits(settings)

    def _rebuild(self) -> None:
        self.by_id: dict[str, ModelProvider] = {
            LOCAL: self.local,
            NETWORK: self.network,
            CLOUD: self.cloud,
            OPENROUTER: self.openrouter,
            **self.connections,
        }

    def load_connections(self, rows: list[dict]) -> None:
        """Make the connection backends match these stored rows.

        Enabled rows only: a switched-off connection is not offered, routed to
        or fallen back on. A connection whose address is unchanged keeps its
        provider object -- its HTTP client and cached model list -- and just
        takes the new key, model and name.
        """
        kept: dict[str, OpenAICompatProvider] = {}
        for row in rows:
            if not row.get("enabled"):
                continue
            preset = get_connection_preset(row.get("preset", "")) or get_connection_preset("custom")
            existing = self.connections.get(row["id"])
            if existing is not None and existing.base_url == (row.get("base_url") or "").rstrip("/"):
                if existing.api_key != (row.get("api_key") or ""):
                    existing.set_api_key(row.get("api_key") or "")
                existing.model = row.get("model") or ""
                existing.label = row.get("name") or preset["label"]
                kept[row["id"]] = existing
                continue
            kept[row["id"]] = OpenAICompatProvider(
                connection_id=row["id"],
                name=row.get("preset") or "custom",
                label=row.get("name") or preset["label"],
                base_url=row.get("base_url") or "",
                api_key=row.get("api_key") or "",
                model=row.get("model") or "",
                preset=preset,
            )
        for connection_id, provider in self.connections.items():
            if kept.get(connection_id) is not provider:
                self._retired.append(provider)
        self.connections = kept
        self._rebuild()
        self.apply_limits(self._settings)

    def fallback(self) -> list[str]:
        """The order Auto tries backends in after the local one."""
        named = [i for i in self.fallback_order if i in self.by_id and i != LOCAL]
        rest = [i for i in self.by_id if i != LOCAL and i not in named]
        return named + rest

    def set_fallback_order(self, order: list[str]) -> list[str]:
        self.fallback_order = [i for i in dict.fromkeys(order) if i != LOCAL]
        return self.fallback()

    def apply_limits(self, settings) -> None:
        """Bring every backend's window, reply cap and caching in line with
        `settings` as they stand now.

        Called at boot and at the start of every turn, so switching Enterprise
        mode on or off reaches the backends on the next message. Attribute
        writes on the live providers, like `set_model`: nothing is rebuilt, and
        a turn already streaming keeps the request it sent.
        """
        local_window = getattr(settings, "context_tokens", None)
        cloud_window = getattr(settings, "cloud_context_tokens", None)
        max_tokens = getattr(settings, "cloud_max_tokens", None)
        ttl = getattr(settings, "cache_ttl", None) or "5m"
        keep_alive = getattr(settings, "ollama_keep_alive", None) or None
        # Each looked up rather than assumed: a router assembled by hand (a
        # test, a one-liner) may carry only some of them.
        for ollama in (getattr(self, "local", None), getattr(self, "network", None)):
            if ollama is None:
                continue
            if local_window:
                ollama.context_tokens = int(local_window)
            ollama.keep_alive = keep_alive
        for cloud in (getattr(self, "cloud", None), getattr(self, "openrouter", None)):
            if cloud is None:
                continue
            if cloud_window:
                cloud.context_tokens = int(cloud_window)
            cloud.cache_ttl = ttl
        cloud = getattr(self, "cloud", None)
        if cloud is not None and max_tokens:
            cloud.max_tokens = int(max_tokens)
        # A connection is windowed like what it is: a hosted service like the
        # other cloud backends, a server on the reader's hardware like Ollama.
        for connection in getattr(self, "connections", {}).values():
            window = local_window if connection.kind == "local" else cloud_window
            if window:
                connection.context_tokens = int(window)
            connection.cache_ttl = ttl

    def set_model(self, provider_id: str, model: str) -> str:
        """Point one backend at a different model.

        Mutating the live provider rather than building a new one: an httpx
        client, a cached catalogue and a cached health probe all hang off these
        objects, and a model change is a change of one string, not of the
        connection underneath it. A turn already streaming keeps the model it
        started with, because the request went out with it.
        """
        provider = self.by_id.get(provider_id)
        if provider is None:
            raise KeyError(provider_id)
        model = (model or "").strip()
        if not model:
            raise ValueError("a model name is required")
        provider.model = model
        return model

    async def resolve(self, prefer: str | None = None) -> Route:
        if prefer in self.by_id:
            return Route(self.by_id[prefer], LOCAL if prefer == LOCAL else "fallback")

        if await self._local_healthy():
            return Route(self.local, LOCAL)
        for provider_id in self.fallback():
            provider = self.by_id[provider_id]
            if await provider.health():
                return Route(provider, "fallback")
        # Nothing is reachable. Hand back local anyway so the caller surfaces
        # the real connection error rather than an invented one.
        return Route(self.local, LOCAL)

    async def _local_healthy(self) -> bool:
        now = time.monotonic()
        if now - self._last_check < _HEALTH_TTL_SECONDS:
            return self._last_healthy
        self._last_healthy = await self.local.health()
        self._last_check = now
        return self._last_healthy

    def invalidate_health(self) -> None:
        """Force the next resolve() to re-probe -- call this after a local failure."""
        self._last_check = 0.0

    async def aclose(self) -> None:
        await self.local.aclose()
        await self.network.aclose()
        await self.openrouter.aclose()
        for provider in [*self.connections.values(), *self._retired]:
            await provider.aclose()
