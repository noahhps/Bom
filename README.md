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


### Optional: image generation
Decks and pages can use generated pictures if you point Bom at an image generator. It is off until you do:
```
IMAGE_GEN_URL=http://127.0.0.1:7860      # Stable Diffusion WebUI / Forge / SD.Next (--api)
IMAGE_GEN_BACKEND=a1111                  # or "openai" for an OpenAI-compatible /v1/images/generations
IMAGE_GEN_MODEL=                         # optional checkpoint / model name
IMAGE_GEN_API_KEY=                       # only for a backend that needs one
```
A generator on this machine or your local network runs without asking. One anywhere else is sent your prompt, so Bom asks before every request. Generated pictures are labelled "AI-generated" wherever they appear.

All interactions stay on‑device; nothing is sent to external services (unless you want it to).

## 🤝 Contributing
Feel free to open issues or pull requests.

---

© 2026 Bom. All rights reserved.
