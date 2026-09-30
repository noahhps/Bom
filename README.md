<div align="center">
  <img src="https://github.com/noahhps/Bom/blob/main/bom-logo.svg?raw=true" alt="Project Logo" width="200">
  <h1>Bom / 봄 </h1>
</div>


## 🚀 Overview
Bom is a **desktop client** built with **Tauri + React** that lets you chat with an AI locally.  It is a thin harness around **Ollama** (the open‑source framework for running large language models on‑device) and exposes a modern GUI instead of a terminal UI.

## ⚙️ Core Features
| Feature | What it does |
|---------|-------------|
| **Local inference** | Uses Ollama to run models such as Mistral, Llama‑2, or any GGUF/ggml weights directly on your CPU/GPU.
| **Tauri + React UI** | A responsive desktop app that looks and feels like a native application.
| **Agent templates** | Built‑in agents for coding, research, analysis, etc.
| **Design & work tools** | A Design tab that opens design conversations, plus slide decks and live spreadsheets in the canvas panel, styled to a design.md standard you pick.
| **Safety sandbox** | Built‑in execution sandboxing.

## 📥 Installation
1. **Clone the repo** (or download the ZIP) to `~/Desktop/Bom`.
2. **Install dependencies** (Node 18+, Rust 1.75+):
   ```
   cd Bom
   npm install
   ```
3. **Install Ollama** (see https://ollama.ai/docs/installation).  Pull a model:
   ```
   ollama pull gpt-oss:20b
   ```
4. **Configure Bom** – Edit `src-tauri/tauri.conf.json` and set the `ollamaModel` field to the model name you pulled.
5. **Run the app**:
   ```
   npm run tauri: dev 
   ```
   or for an application build of the project:
   ```
   npm run tauri: build
   ```
   The Tauri window will launch and you can start chatting.


### More model providers
Besides Ollama, Anthropic and OpenRouter, **Settings → Models → Add a provider** connects OpenAI, Google Gemini, xAI, Mistral, DeepSeek, Groq, Cerebras, Together, Fireworks and Azure OpenAI. It also connects servers you run yourself (LM Studio, vLLM, llama.cpp, Jan) and any other OpenAI-compatible endpoint. Keys are checked before they're saved, and you set the order Auto falls back in. See [docs/providers.md](docs/providers.md).

### Optional: image generation
Decks and pages can use generated pictures if you point Bom at an image generator. It is off until you do:
```
IMAGE_GEN_URL=http://127.0.0.1:7860      # Stable Diffusion WebUI / Forge / SD.Next (--api)
IMAGE_GEN_BACKEND=a1111                  # or "openai" for an OpenAI-compatible /v1/images/generations
IMAGE_GEN_MODEL=                         # optional checkpoint / model name
IMAGE_GEN_API_KEY=                       # only for a backend that needs one
```
A generator on this machine or your local network runs without asking. One anywhere else is sent your prompt, so Bom asks before every request. Generated pictures are labelled "AI-generated" wherever they appear.

### Design work: context and revisions
Design turns are long, so the window is sized for them. Every value is optional:
```
CONTEXT_TOKENS=65536        # Ollama's num_ctx; capped at what the model was trained on
CLOUD_CONTEXT_TOKENS=200000 # the window for Anthropic / OpenRouter, capped at the model's own
REPLY_TOKENS=8192           # headroom kept for a reply (a whole page arrives as one tool call)
CLOUD_MAX_TOKENS=64000      # the longest cloud reply
CANVAS_READ_CHARS=60000     # how much of a canvas read_canvas returns before paging
RESULT_CHARS=12000          # how much of any other tool result the model sees
MAX_TOOL_ROUNDS=24
```
Lower `CONTEXT_TOKENS` if the local model runs short of memory: the KV cache grows with it.

Long conversations are compacted rather than cut off: once the history fills half the window, the older turns are summarized and the recent ones are still sent word for word (`COMPACT_AT`, `COMPACT_KEEP`, `COMPACT_SUMMARY_TOKENS`; `COMPACT_AT=0` turns it off). Cloud requests ask for prompt caching, so a tool loop doesn't pay full price for the same conversation every round (`CACHE_TTL=5m` or `1h`).

### Enterprise mode
For company use, with long conversations, large codebases and big cloud context windows, switch on **Settings → Enterprise mode**. It raises the context window, tool-result sizes, round and timeout limits, compacts later while keeping more of the conversation verbatim, and holds the prompt cache for an hour. Safety settings don't change. See [docs/enterprise.md](docs/enterprise.md) for every limit and the `ENTERPRISE_*` variables that tune them.

### Work tools (MCP)
**Skills → MCP servers & presets → Work tools** connects Atlassian (Jira, Confluence), Linear, Notion, Sentry, Stripe and any other hosted MCP server that signs in with OAuth, including your company's own. Choose *Add & sign in*, approve Bom on the service's page, and its tools are ready. Jira and Confluence Server / Data Center connect with tokens. See [docs/work-tools.md](docs/work-tools.md).

Work in the canvas is revised in place rather than rewritten: `edit_canvas` (find and replace, or `css_vars` to restyle a page built on tokens), `edit_wireframe` (layers and frames by id), `edit_slides` and `edit_sheet`. Every write and edit reports plain breakages -- contrast, unbalanced markup, layers off the screen -- and `check_design` gives a fuller review. For a model that can see, `view_canvas` shows it a picture of a page or a wireframe, drawn with Chrome/Chromium/Edge/Brave if one is installed (or `CHROME_PATH`) and otherwise Quick Look on a Mac; scripts don't run and nothing is fetched from the internet.

All interactions stay on‑device; nothing is sent to external services (unless you want it to).

## 🤝 Contributing
Feel free to open issues or pull requests.

---

© 2026 Bom. All rights reserved.
