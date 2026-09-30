# Model providers

Bom has four built-in backends: Ollama on this machine, Ollama on another
machine on your network, Anthropic, and OpenRouter. **Settings → Models → Add a
provider** connects anything else that speaks OpenAI's chat-completions API.

| Service | Preset | Key from |
| --- | --- | --- |
| OpenAI | `openai` | platform.openai.com → API keys |
| Google Gemini (OpenAI-compatible endpoint) | `gemini` | aistudio.google.com → Get API key |
| xAI (Grok) | `xai` | console.x.ai |
| Mistral | `mistral` | console.mistral.ai |
| DeepSeek | `deepseek` | platform.deepseek.com |
| Groq | `groq` | console.groq.com |
| Cerebras | `cerebras` | cloud.cerebras.ai |
| Together AI | `together` | api.together.ai |
| Fireworks AI | `fireworks` | fireworks.ai |
| Azure OpenAI | `azure_openai` | Azure portal → your resource → Keys and Endpoint |
| Any OpenAI-compatible server, such as a company gateway | `custom` | if it asks for one |
| LM Studio | `lmstudio` | none; address defaults to `127.0.0.1:1234` |
| vLLM | `vllm` | only if started with `--api-key`; address defaults to `127.0.0.1:8000` |
| llama.cpp (`llama-server`) | `llamacpp` | only if started with `--api-key`; `127.0.0.1:8081`, since 8080 is Bom's port |
| Jan | `jan` | none; `127.0.0.1:1337` |

## Adding one

Pick a service and give it a key. For local servers, Azure and `custom`, also
give its address. Then press **Check**: Bom tries the key and lists the models
it can reach, leaving out embedding, speech and image models. Pick a model and
add the connection. A wrong key or a server that isn't running shows up at
Check, not on your first message.

Azure OpenAI doesn't list your deployments, so you type the deployment name as
the model. The same field appears for any service whose list comes back empty.

Each connection shows up everywhere a backend does:
- the composer's model menu;
- the "Answer with" choices;
- the fallback order.

You can rename it, replace its key, switch it off (it stays listed but isn't
used) or remove it. The key stays on the server, in the `model_connections`
table, and is never sent back to the browser.

## Fallback order

**Auto** uses the local Ollama first. When that isn't answering, it tries the
other backends in the order shown under **Fallback order** and uses the first
one that is reachable. A new connection is added at the end. The order is saved
on the server (`providers.fallback_order`).

## What each service gets

Most of these services agree on the basics and differ in the details. Bom
handles the differences:

- **Reasoning.** The model's reasoning is shown whether the service sends it as
  `reasoning_content` (DeepSeek, xAI, vLLM, LM Studio) or as `reasoning` (Groq).
- **Effort.** OpenAI, Gemini and Azure get Bom's effort control, sent as
  `reasoning_effort`. Other services show no control.
- **Refused options.** If a model rejects an optional setting (`reasoning_effort`
  on a model that doesn't reason, or `stream_options`), Bom sends the request
  again without it and remembers that for the model.
- **Caching.** Every one of these services caches a repeated prompt start on its
  own. The share read from cache is shown on the answer.
- **Context window.** Taken from the service's model list when it gives one
  (Groq, Together, Mistral, vLLM). Otherwise the preset's default is used, capped
  at the cloud window for hosted services and at the local window for servers on
  your own machines. Enterprise mode raises both.
- **Pictures.** Sent only to models the service lists as seeing images, or whose
  service generally does. They're never sent to a local server, where the model
  is unknown.

## Anthropic key

The Anthropic card has a **Paste a key** field. Bom checks the key before saving
it (in `data/anthropic_key`). `ANTHROPIC_API_KEY` in the server's environment
still takes priority at startup.

## Over HTTP

All under `/api`, with the bearer token:

| Method | Path | |
| --- | --- | --- |
| GET | `/connections/presets` | the services above |
| POST | `/connections/check` | `{preset, name, base_url, api_key}` → `{ok, models, error}` |
| POST | `/connections` | `{preset, name, base_url, api_key, model}` |
| PATCH | `/connections/{id}` | any of `name`, `base_url`, `api_key`, `model`, `enabled` |
| DELETE | `/connections/{id}` | |
| PUT | `/providers/order` | `{order: [provider ids]}` |
| PUT | `/providers/cloud/key` | `{key}`; empty forgets it |

`GET /models` lists each connection as a provider, with `label` and
`connection` (never the key), plus `connections` (including switched-off ones)
and the fallback `order`.
