---
name: github-ops
description: Commit, push, open PRs, run and watch GitHub Actions workflows, manage releases via git and the gh CLI.
---
# GitHub operations

Use `run_command` with `git` and `gh`. If something fails, check `git status` and `gh auth status` first.

## Commit & push
- `git status` to see what changed.
- `git add -A && git commit -m "<message>"` then `git push`.
- If on `main`/`master` or detached, create a branch first: `git checkout -b <type>/<short-desc>`.
- Never commit secrets or large binaries. Inspect the diff with `git diff --staged` before committing.

## Pull requests
- Create: `gh pr create --fill` (or `--title "..." --body "..."`).
- Status / checks: `gh pr status`, `gh pr checks`.

## GitHub Actions workflows
- List: `gh workflow list`
- Run: `gh workflow run <name-or-file.yml> [--ref <branch>] [-f key=value ...]`
- Watch results: `gh run list --workflow <name>`, then `gh run watch <run-id>` or `gh run view <run-id> --log`.

## Releases
- `gh release create <tag> [files...] --notes "..."`
- `gh release upload <tag> <file> --clobber`

Verify the outcome (e.g. `gh run view`) rather than assuming success.
