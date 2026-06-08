# LocalSRE — local agentic coding for VS Code

A lightweight VS Code extension that turns your **local** model (Qwen3-Coder, DeepSeek-Coder-V2-Lite, or DeepSeek-R1) into an agentic coding assistant — like Claude Code / Copilot, but 100% offline. No cloud, no tokens.

It drives the model through a real **tool-calling agent loop** with a **skills** system, and is built to **hunt for the solution, not give up**.

## What it can do
- Read/write files, list dirs, run shell commands (with your approval)
- Run **git / `gh`** (commit, push, PRs, workflows), **kubectl** (GKE), **gcloud** (deploy + troubleshoot, Vertex AI)
- Install via **brew** and **pip** (PATH fixed so they resolve)
- Read **PDF/DOCX** and **OCR screenshots** (text only)
- Scaffold + run **React / Angular / Next / Vue / FastAPI / Flask / Streamlit** end-to-end, with a live in-editor preview

### Skills (in `skills/`, load on demand)
`scaffold` · `github-ops` · `kubernetes` · `gcp` · `python-env` · `homebrew` · `documents`
Add your own by dropping a `name`/`description` front-mattered `.md` file in `skills/`.

## Setup
1. **Serve your model** with llama.cpp (the `--jinja` flag is REQUIRED for tool-calling):
   ```bash
   llama-server -m Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf -c 24576 --port 8080 --jinja --temp 0.2
   ```
   Swap the `-m` path to run DeepSeek-Coder-V2-Lite or DeepSeek-R1 instead — the extension talks to whatever is loaded.

2. **Run the extension** (dev mode): open this folder in VS Code → press **F5** → a new window opens with the **LocalSRE** icon in the activity bar.

   To install permanently, package it: `npx @vscode/vsce package` → `code --install-extension localsre-0.5.0.vsix`.

3. **Configure** (Settings → "LocalSRE") if needed: `endpoint` (default `http://localhost:8080/v1`), `temperature`, `autoApproveCommands` (leave OFF for safety).

## Model notes
- **Qwen3-Coder-30B-A3B** — best agent; needs recent llama.cpp + `--jinja` or it apologizes instead of acting.
- **DeepSeek-Coder-V2-Lite** — decent, weaker multi-step tool-calling.
- **DeepSeek-R1-14B** — a *reasoning* model; its `<think>` blocks are auto-stripped, but it's not a strong agent (use for hard reasoning, not driving tools).

## Limitations
- **Text-only models** — they cannot *see* images. Screenshots are handled via OCR (text only). For true vision, mirror a vision model (e.g. Qwen2.5-VL) and add multimodal support.
- All actions that touch your system ask for approval unless `autoApproveCommands` is on.
