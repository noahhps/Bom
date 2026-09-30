"""The services a connection can be made to, as data.

Every one of these speaks OpenAI's chat-completions API (see openai_compat.py);
what differs is here: where it lives, whether it needs a key and where to get
one, how it spells reasoning, and the few things it will not accept.

`kind` decides which window a connection gets under Enterprise mode and the
settings: "cloud" is sized like the other cloud backends (CLOUD_CONTEXT_TOKENS),
"local" like Ollama (CONTEXT_TOKENS) -- a model on the reader's own hardware
has the same memory limits whichever server runs it.
"""

from __future__ import annotations

from typing import Any

CONNECTION_PRESETS: dict[str, dict[str, Any]] = {
    # -- cloud services --------------------------------------------------------
    "openai": {
        "label": "OpenAI",
        "kind": "cloud",
        "base_url": "https://api.openai.com/v1",
        "key_required": True,
        "key_help": "platform.openai.com > API keys",
        "reasoning": "effort",
        "vision": True,
        "homepage": "openai.com",
        "blurb": "GPT models, straight from OpenAI.",
    },
    "gemini": {
        "label": "Google Gemini",
        "kind": "cloud",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "key_required": True,
        "key_help": "aistudio.google.com > Get API key",
        "reasoning": "effort",
        "vision": True,
        # Its listing names models "models/gemini-...", and chat takes the
        # bare name.
        "strip_model_prefix": "models/",
        "window": 1_000_000,
        "homepage": "ai.google.dev",
        "blurb": "Gemini through Google's OpenAI-compatible endpoint.",
    },
    "xai": {
        "label": "xAI",
        "kind": "cloud",
        "base_url": "https://api.x.ai/v1",
        "key_required": True,
        "key_help": "console.x.ai > API keys",
        "vision": True,
        "window": 256_000,
        "homepage": "x.ai",
        "blurb": "Grok models.",
    },
    "mistral": {
        "label": "Mistral",
        "kind": "cloud",
        "base_url": "https://api.mistral.ai/v1",
        "key_required": True,
        "key_help": "console.mistral.ai > API keys",
        # Mistral reports usage on the last chunk without being asked, and
        # does not take the option that asks.
        "usage_option": False,
        "homepage": "mistral.ai",
        "blurb": "Mistral's own models, hosted in the EU.",
    },
    "deepseek": {
        "label": "DeepSeek",
        "kind": "cloud",
        "base_url": "https://api.deepseek.com",
        "key_required": True,
        "key_help": "platform.deepseek.com > API keys",
        "homepage": "deepseek.com",
        "blurb": "DeepSeek's chat and reasoning models.",
    },
    "groq": {
        "label": "Groq",
        "kind": "cloud",
        "base_url": "https://api.groq.com/openai/v1",
        "key_required": True,
        "key_help": "console.groq.com > API keys",
        "homepage": "groq.com",
        "blurb": "Open models at very high speed.",
    },
    "cerebras": {
        "label": "Cerebras",
        "kind": "cloud",
        "base_url": "https://api.cerebras.ai/v1",
        "key_required": True,
        "key_help": "cloud.cerebras.ai > API keys",
        "homepage": "cerebras.ai",
        "blurb": "Open models at very high speed.",
    },
    "together": {
        "label": "Together AI",
        "kind": "cloud",
        "base_url": "https://api.together.xyz/v1",
        "key_required": True,
        "key_help": "api.together.ai > Settings > API keys",
        "homepage": "together.ai",
        "blurb": "Hundreds of open models, hosted.",
    },
    "fireworks": {
        "label": "Fireworks AI",
        "kind": "cloud",
        "base_url": "https://api.fireworks.ai/inference/v1",
        "key_required": True,
        "key_help": "fireworks.ai > Settings > API keys",
        "homepage": "fireworks.ai",
        "blurb": "Open models, hosted and fine-tunable.",
    },
    "azure_openai": {
        "label": "Azure OpenAI",
        "kind": "cloud",
        "base_url": "https://YOUR-RESOURCE.openai.azure.com/openai/v1",
        "url_editable": True,
        "key_required": True,
        "key_header": "api-key",
        "key_help": "Azure portal > your OpenAI resource > Keys and Endpoint",
        "reasoning": "effort",
        "vision": True,
        "homepage": "azure.microsoft.com",
        "blurb": "OpenAI models in your company's Azure tenant. The model is your deployment's name.",
    },
    "custom": {
        "label": "Other (OpenAI-compatible)",
        "kind": "cloud",
        "base_url": "",
        "url_editable": True,
        "key_required": False,
        "key_help": "If the server asks for one.",
        "blurb": "Any server that speaks OpenAI's chat API, including your company's own gateway.",
    },
    # -- on this machine or the network ------------------------------------------
    "lmstudio": {
        "label": "LM Studio",
        "kind": "local",
        "base_url": "http://127.0.0.1:1234/v1",
        "url_editable": True,
        "key_required": False,
        "homepage": "lmstudio.ai",
        "blurb": "LM Studio's local server (Developer > Start server).",
    },
    "vllm": {
        "label": "vLLM",
        "kind": "local",
        "base_url": "http://127.0.0.1:8000/v1",
        "url_editable": True,
        "key_required": False,
        "key_help": "Only if it was started with --api-key.",
        "homepage": "vllm.ai",
        "blurb": "A vLLM server, on this machine or a GPU box on the network.",
    },
    "llamacpp": {
        "label": "llama.cpp",
        "kind": "local",
        # Not llama-server's default 8080: that is Bom's own port.
        "base_url": "http://127.0.0.1:8081/v1",
        "url_editable": True,
        "key_required": False,
        "key_help": "Only if it was started with --api-key.",
        "homepage": "github.com",
        "blurb": "llama-server, started with --port 8081 (8080 is Bom's).",
    },
    "jan": {
        "label": "Jan",
        "kind": "local",
        "base_url": "http://127.0.0.1:1337/v1",
        "url_editable": True,
        "key_required": False,
        "homepage": "jan.ai",
        "blurb": "Jan's local API server.",
    },
}


def get_connection_preset(preset_id: str) -> dict[str, Any] | None:
    return CONNECTION_PRESETS.get((preset_id or "").strip().lower())


def list_connection_presets() -> list[dict[str, Any]]:
    return [{"id": key, **value} for key, value in CONNECTION_PRESETS.items()]
