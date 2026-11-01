# Model providers

Bom has five built-in backends: Ollama on this machine, Ollama on another
machine on your network, Anthropic (API key), OpenRouter, and your Claude plan
through Claude Code. **Settings → Models → Add a
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

## Your Claude plan (through Claude Code)

The **Claude plan** card answers with the Claude subscription you already pay
for (Pro, Max, Team or Enterprise) instead of an API key.

Anthropic only allows a plan to be used through its own apps. Its terms
(code.claude.com/docs/en/legal-and-compliance, "Authentication and credential
use") say a third-party app may not offer Claude.ai login, route requests
through plan credentials, or collect, store or pass along Claude.ai tokens.
They also say this doesn't stop you signing in to the **unmodified Claude Code
binary** with your own plan. So that's how Bom does it:

- Bom runs the `claude` command you installed, as published, in print mode
  (`claude -p`). Set `CLAUDE_CODE_BIN` if it isn't on the server's `PATH`.
- You sign in inside Claude Code, through Anthropic's own flow:
  `claude auth login` in a terminal on the machine running Bom. Bom asks
  `claude auth status` whether that's done. That command reports a sign-in
  method and a yes/no, never a token.
- Bom never reads Claude Code's credentials, keychain entry or config files,
  and never calls Anthropic itself.
- It's your plan, used by you, on your machine. Usage counts against your
  plan's limits like any other Claude Code use. Anthropic sets those limits
  for ordinary individual use; for heavy automated work (many scheduled
  tasks, say), use an API key on the Anthropic card instead.

How a turn runs: each message starts one `claude -p` process. Claude Code's
own tools are switched off (`--tools ""`). Bom's skills are offered to it as
an MCP server served by Bom itself, on loopback, behind a secret that exists
only for that turn (`/api/claude-code/mcp/<secret>`). When Claude calls a
skill, Bom runs it as it would for any backend (approvals, canvas, the
browser panel) and hands the result back to the same process, which carries
on. Earlier messages are sent as a transcript ahead of the newest one, so
Bom stays the one place the conversation lives.

Claude Code runs in `data/claude-code/`, an empty folder, so no project's
`CLAUDE.md`, settings or `.mcp.json` is loaded. `ANTHROPIC_API_KEY` is
removed from its environment, so the plan pays rather than a key the server
happens to have. Your own `~/.claude` settings still apply, because it's
your Claude Code.

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
