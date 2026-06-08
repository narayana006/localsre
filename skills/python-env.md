---
name: python-env
description: Install Python libraries and manage environments with pip and venv.
---
# Python environments & libraries

Install libraries with `run_command`. Installs can take a while — wait for them, then verify by importing.

## Installing
- Prefer an isolated env for a project: `python3 -m venv .venv && source .venv/bin/activate`
- Then: `pip install <pkg>`  (fallback: `python3 -m pip install <pkg>`)
- From a file: `pip install -r requirements.txt`
- If you hit an "externally-managed-environment" error: use a venv, or `pip install --user <pkg>`.

## Verify
- `python3 --version`, `pip list`
- `python3 -c "import <pkg>; print(<pkg>.__version__)"`

## Common
- Upgrade pip if installs misbehave: `python3 -m pip install --upgrade pip`
- After installing, actually import/use the library to confirm it works before reporting done.
