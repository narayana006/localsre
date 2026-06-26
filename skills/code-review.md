---
name: code-review
description: Review a diff or PR for correctness bugs, security issues, performance problems, and style gaps — give ranked findings with exact file:line references and minimal fix suggestions. Trigger words: review, PR, diff, code review, check, LGTM, pull request.
---
# Code review playbook

Goal: produce a ranked, actionable review with zero hallucinated line numbers. Read everything before writing a single comment.

## Step 1 — Read the full diff first (no comments yet)

Run `git diff main...HEAD` (or `git diff <base>..<head>`) and read it end-to-end. Do NOT comment on the first file you see. Hold all observations until you have the complete picture.

If reviewing a GitHub PR: `gh pr diff <number>` to get the diff. `gh pr view <number>` for description + linked issues.

Skim for:
- What is this change trying to do? (understand intent before judging)
- Which files are touched? Which are load-bearing vs. incidental?
- What is NOT in the diff but probably should be? (missing tests, missing docs, missing error handling)

## Step 2 — Gather context for changed files

For every file with logic changes (not just formatting), read the surrounding context:
- `read_file` the changed function + 10 lines above/below the hunk.
- `search_code` for callers of any changed function signature.
- Check if tests exist: `find . -name "test_<file>*" -o -name "<file>.test.*"`.

Do NOT skip this step. Line numbers in a diff can be misleading without context.

## Step 3 — Categorize findings into four buckets

Rank within each bucket by severity. Only report a finding if you have the exact file:line.

### CORRECTNESS (must fix before merge)
- Off-by-one errors, wrong operator, incorrect null/undefined check.
- Race conditions, missing await, promise not returned.
- Wrong variable shadowing existing binding.
- Logic that contradicts the stated intent of the PR.

Example finding format:
  `auth/session.js:47` — `user.id` is used before the null check at line 51. If `user` is null this throws before the guard. Move the guard to line 44 or use optional chaining.

### SECURITY (must fix before merge)
- Hardcoded credentials, tokens, API keys (even in tests).
- User input reaching shell commands, SQL, or `eval` without sanitization.
- Endpoint now exposed without auth that was previously protected.
- Overly permissive CORS, missing CSRF token, open redirect.
- Secrets logged at any log level.

If unsure whether something is a real secret: flag it as "verify this is not a real credential".

### PERFORMANCE (fix if easy, note otherwise)
- N+1 query pattern introduced (loop calling DB/API per iteration).
- Synchronous blocking call in async hot path.
- Large object serialized unnecessarily on every request.
- Missing index for a new WHERE clause.

### STYLE / MAINTAINABILITY (optional, group together)
- Inconsistency with the surrounding code's naming conventions.
- Dead code left in.
- Comment that contradicts what the code does.
- Missing error message on a thrown exception.

## Step 4 — Write the review

Format:

```
## Code Review — <PR title or branch>

### Summary
<1–3 sentences: what the change does, overall impression>

### CORRECTNESS (N findings)
- [ ] `file.py:42` — <issue>. Fix: <minimal one-line fix or approach>.
- [ ] `file.py:88` — ...

### SECURITY (N findings)
- [ ] `config.js:12` — Hardcoded token string. Remove and load from env: `process.env.API_TOKEN`.

### PERFORMANCE (N findings — skip section if none)
- [ ] `db/queries.py:67` — N+1 query: `get_user()` called inside loop. Batch with `get_users_by_ids(ids)`.

### STYLE (grouped, low priority)
- `utils.js:5` — variable named `data` shadows outer `data` at line 2. Rename inner to `userData`.
- `README.md` missing update for the new `--flag` option added in `cli.js:31`.

### Missing (things NOT in the diff that should be)
- No test for the error path at `handler.js:55` — add a test that passes a null `req.user`.

### Verdict
LGTM with blocking issues above addressed / LGTM / Request changes
```

## Rules

- Never cite a line number you haven't read with read_file. If you're unsure, say "around line N — verify exact location".
- Suggest the MINIMAL fix — do not rewrite the whole function if one line is wrong.
- If a pattern appears 5+ times, flag it once with "(and N similar occurrences — search_code '<pattern>' to find all)".
- Separate "must fix" from "nice to have" clearly. Do not block a PR on style.
- If you cannot determine whether something is a bug without knowing the caller's contract, say so and ask one specific question.
- Match the existing code style in any suggested fixes — do not introduce new patterns.
