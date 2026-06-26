---
name: debugging
description: Systematic bug debugging methodology — state symptoms, form one hypothesis, gather evidence, test it with a single targeted check, confirm or refute, repeat. Never retry the same failing command twice. Trigger words: bug, error, failing, broken, debug, exception, traceback, why is, not working, crash, unexpected.
---
# Debugging playbook

Goal: shortest path from "something is wrong" to "confirmed root cause + fix". One hypothesis at a time. No shotgun changes.

## Step 1 — State the symptom precisely (before touching anything)

Write out:
- What behavior is observed? (exact error message, exact output)
- What behavior is expected?
- When did it start? (after which change, deploy, or event — if known)
- Is it 100% reproducible or intermittent?

Example:
  "Running `python app.py` crashes with `KeyError: 'user_id'` at `session.py:34`. Expected: returns the session dict. Started after the merge of PR #142 yesterday."

Do NOT run any commands yet. Incomplete symptom statements lead to wrong hypotheses.

## Step 2 — Form ONE hypothesis

Based solely on the symptom (not intuition), state:
- What you think is wrong
- Why you think that explains the symptom
- What evidence would CONFIRM it
- What evidence would REFUTE it

Example:
  "Hypothesis: PR #142 renamed `userId` to `user_id` in the auth module but the session module still reads `userId`. This would cause a KeyError at exactly that line. Confirm: session.py reads `session['userId']`. Refute: session.py already uses `user_id`."

One hypothesis at a time. Do not list "it could be A or B or C".

## Step 3 — Gather evidence (read-only)

Read the specific code mentioned in the error, not the whole file:
- `read_file` the file:line from the traceback. Read 20 lines above and below.
- `search_code` for the key/variable/function name that caused the error — find where it's defined and where it's set.
- If there's a log file: `run_command grep -n "ERROR\|WARN\|KeyError" app.log | tail -50` — do NOT dump the whole log.
- If the error is in a dependency: read only the specific method in question.

Do NOT edit any files yet. Do NOT run the failing command again — you already know it fails.

## Step 4 — Test the hypothesis with ONE check

Design the single smallest check that would prove or disprove your hypothesis:
- Read the exact variable name in the suspicious file.
- Add a one-line `print()` / `console.log()` before the crash line and re-run.
- `grep -n "userId\|user_id" session.py` — does the old key appear?
- Check the git diff of the specific function: `git log -p --follow -S "userId" session.py`

Run exactly that one check. Then:
- If CONFIRMED → go to Step 5.
- If REFUTED → discard this hypothesis entirely. Go back to Step 2 with a new hypothesis based on what you just learned.

Never run the same failing command twice. If `pytest test_session.py` failed, do not run it again until you have changed something.

## Step 5 — Fix the confirmed cause (minimum viable change)

Fix ONLY what the hypothesis identified. Rules:
- Touch the fewest lines possible. Do not refactor while fixing.
- If fixing requires changing more than one file: list all files first, confirm with user before editing more than one.
- Read the file with `read_file` in this session before editing — even if you just read it in Step 3.
- After editing: show what changed and why in one sentence.

Example minimal fix:
  "session.py:34 — changed `session['userId']` to `session['user_id']` to match the key set by auth.py:19 after PR #142."

## Step 6 — Verify the fix

Run the reproduction case. Do not assume the fix worked.
- Run the exact command that failed in Step 1.
- If there are tests: `run_command pytest tests/test_session.py -x` — look for green.
- If the error is gone: state "Verified: `python app.py` no longer throws KeyError."
- If a NEW error appears: treat it as a new symptom. Go back to Step 1. Do NOT start changing random things.

## Step 7 — Check for recurrence

Ask: could this same bug exist in other places?
- `search_code "userId"` — are there other files that still use the old key?
- If yes: fix them all (they have the same confirmed root cause), list all files changed.
- If the bug is a pattern (e.g., "we never validate this field"): note it but do not expand scope without user confirmation.

## Hard rules

- NEVER change two things at once to "see which one fixes it". One change, verify, then next.
- NEVER retry a failing command without having changed something first.
- NEVER add debug logging and leave it in — remove it before declaring done.
- If after 3 hypothesis/test cycles you haven't confirmed a root cause: stop and state exactly what you've ruled out and what you need (a specific log, access to a system, a repro script) — ask one question.
- Do not declare the bug fixed until Step 6 is green.

## Common error patterns (check first)

| Error | First place to look |
|---|---|
| KeyError / AttributeError | The key/attr name — find where it's set vs where it's read |
| ImportError / ModuleNotFoundError | `pip list / npm ls` — is the package installed in this env? |
| Permission denied | `ls -la <file>` — wrong owner or mode |
| Port already in use | `lsof -i :<port>` — what process holds it |
| Timeout / connection refused | Is the dependency service running? `curl -v <url>` |
| Works locally / fails in CI | Env vars, secrets, file paths, OS differences — diff the environments |
