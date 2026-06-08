---
name: homebrew
description: Install and manage command-line tools and apps with Homebrew (brew).
---
# Homebrew (brew)

`brew` is already on PATH for you. Use `run_command`.

- Install a tool/library: `brew install <formula>`  (e.g. `brew install poppler jq kubectl tesseract`)
- Install a GUI app: `brew install --cask <name>`
- Search / info: `brew search <term>`, `brew info <formula>`
- Upgrade: `brew upgrade <formula>`

Notes:
- Installs may take several minutes (compiling) — be patient and wait for completion.
- After installing, verify: `which <tool>` or `<tool> --version`.
- If `brew` itself is missing, ask the user before running the official installer (it modifies the system).
