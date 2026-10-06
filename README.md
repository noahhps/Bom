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
| **Messages** | Conversations laid out like a messenger: write to Bom or one of your agents, or start a group chat with several of them.
| **Office agents** | Ready-made agents for everyday work (Secretary, Analyst, Researcher, Writer, Clerk, Planner), each with the short toolbox its job needs.
| **Studio (opt-in)** | Design and code workspaces: decks, wireframes, pages and code projects. Off by default; turn it on in **Settings → General**.
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


### Messages and group chats
Bom is built for everyday work on a small local model: the calendar, reminders, drafting, spreadsheets, paperwork and research. So the home screen is **Messages**.

Each agent has **one conversation**, like a contact in a messenger. Writing to an agent (the pencil, or **Message** on the Agents page) always opens that conversation and carries it on. The server enforces this too, and an agent's scheduled tasks post into it, so the Secretary's reminder arrives where you talk to the Secretary. If older builds left an agent with several conversations, they appear as one thread, the earlier parts above a dated divider.

**Conversations with more than one agent** are created as often as you like, each named by its topic. Press **New group** (or put two or more agents on the To: line; the ⊕ adds another) and the first message makes the group. If a group with exactly those agents already exists, it's offered under the To: line so you can carry it on instead. Chats with Bom itself work the same way.

In a group, one member answers each message: whoever you @-mention (`@Analyst`), everyone for `@everyone`, and otherwise whoever answered last. Each answer is a full turn run as that agent, with its instructions and its tools. The others' replies reach it as messages from them, not as its own words. Add or remove members from the conversation's details (click the names at the top).

Each ready-made agent gets a short list of tools rather than all of them, because a small model choosing from a dozen tools picks the wrong one far less often than one choosing from forty. `@connectors` in an agent's skill list means every connected MCP server's tools, so the Secretary can reach the mail or calendar server you connect later. The design tools (decks, wireframes, design checks, image generation) and the shell are offered only in Studio's design conversations, never in a chat.

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

### Tool calls that mend themselves
Small local models often call the right tool slightly wrong. Bom repairs a call before it asks you to approve it, but only where there is one thing the model could have meant. It fixes a misspelled or prefixed tool name (`functions.webSearch` becomes `web_search`), an argument in the wrong case or with a typo, arguments wrapped in an extra `arguments` object, a value of the wrong type (`"7"` where a number goes), and arguments that are nearly JSON. A call the model wrote into its reply as text, such as `<tool_call>{…}</tool_call>`, runs as a call. The model is told what was fixed so it spells it right next time. A call that can't be repaired, because its arguments won't decode or it has none of the ones it needs, doesn't run. The model gets the tool's parameters back so it can send the call again. See `server/app/heal.py`.

### Enterprise mode
For company use, with long conversations, large codebases and big cloud context windows, switch on **Settings → Enterprise mode**. It raises the context window, tool-result sizes, round and timeout limits, compacts later while keeping more of the conversation verbatim, and holds the prompt cache for an hour. Safety settings don't change. See [docs/enterprise.md](docs/enterprise.md) for every limit and the `ENTERPRISE_*` variables that tune them.

### Remote access
Use your Bom, with its models, conversations and files, from anywhere, with no port forwarding. Your machine connects out to a relay in your own free Supabase project, and a web app on Vercel (or the desktop app) talks to it through that relay. It stays off until you turn it on **at the machine itself**, and it serves only the account you link it to with a one-time code shown on that machine.
```
./relay/setup.sh <project-ref> https://<your-app>.vercel.app   # once: tables, rules, sign-in
./run.sh --remote                         # on the host: prints a code to link it
```
Or use **Settings → Remote access** on the host. See [docs/remote.md](docs/remote.md) for the Vercel deploy and how access is checked.

### Browsing the web
The model has two browsers, and the choice between them is the whole design. **Bom's browser** is a private Chromium with its own profile under `data/browser/`, signed in to nothing: `open_page`, `read_page`, `act_on_page` and (for a model that can see) `view_page`. It reads a page as numbered controls and text, acts on a control by its number, and you see a picture of the page after every step in the panel beside the conversation. It runs any Chrome, Chromium, Edge or Brave already on the machine (or `BROWSER_PATH`), and **Settings → Browser** can fetch Google's plain *Chrome for Testing* build onto a machine that has none.

**Your browser** is the one you use yourself, with your accounts in it -- for the few things that need them: your mail, a dashboard, an order. Off until you pick a browser in **Settings → Browser**; then `open_in_my_browser`, `read_my_browser` and `act_in_my_browser` work in its front tab through Apple Events (macOS), and every step there is put to you first, whatever the ask-first switch says. The model is told never to type a password, a code or a card number: when a page wants one, it opens the page in your browser and asks you to sign in yourself. See [docs/browser.md](docs/browser.md).

### Work tools (MCP)
**Skills → MCP servers & presets → Work tools** connects Atlassian (Jira, Confluence), Linear, Notion, Sentry, Stripe and any other hosted MCP server that signs in with OAuth, including your company's own. Choose *Add & sign in*, approve Bom on the service's page, and its tools are ready. Jira and Confluence Server / Data Center connect with tokens. See [docs/work-tools.md](docs/work-tools.md).

Work in the canvas is revised in place rather than rewritten: `edit_canvas` (find and replace, or `css_vars` to restyle a page built on tokens), `edit_wireframe` (layers and frames by id), `edit_slides` and `edit_sheet`. Every write and edit reports plain breakages -- contrast, unbalanced markup, layers off the screen -- and `check_design` gives a fuller review. For a model that can see, `view_canvas` shows it a picture of a page or a wireframe, drawn with Chrome/Chromium/Edge/Brave if one is installed (or `CHROME_PATH`) and otherwise Quick Look on a Mac; scripts don't run and nothing is fetched from the internet.

All interactions stay on‑device; nothing is sent to external services (unless you want it to).

## 🤝 Contributing
Feel free to open issues or pull requests.

---

© 2026 Bom. All rights reserved.
