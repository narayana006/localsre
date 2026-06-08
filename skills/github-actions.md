---
name: github-actions
description: Author, debug, and migrate CI/CD with GitHub Actions — workflows, jobs, matrix, secrets, keyless GCP auth (OIDC/WIF), Jenkins migration.
---
# GitHub Actions (CI/CD)

Workflows live in `.github/workflows/*.yml`. Use the github-ops skill to run/watch; this skill is for AUTHORING and DEBUGGING.

## Structure
```yaml
name: ci
on: { push: { branches: [main] }, pull_request: {}, workflow_dispatch: {} }
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4   # or setup-python / setup-go
        with: { node-version: 20 }
      - run: npm ci && npm test
```
- Matrix: `strategy: { matrix: { v: [18,20] } }` → `${{ matrix.v }}`
- Cache: `actions/cache@v4` (or the cache option in setup-*)
- Secrets: `${{ secrets.NAME }}`; env at workflow/job/step level
- Reuse: `uses: org/repo/.github/workflows/x.yml@main` (with `on: workflow_call`) or composite actions

## Deploy to GCP — keyless (preferred: OIDC / Workload Identity Federation)
```yaml
permissions: { id-token: write, contents: read }
steps:
  - uses: google-github-actions/auth@v2
    with: { workload_identity_provider: <provider>, service_account: <sa> }
  - uses: google-github-actions/setup-gcloud@v2
  - run: gcloud container clusters get-credentials <c> --region <r>
```
Avoid long-lived SA keys — use WIF.

## Debug failing runs
- `gh run list --workflow <name>` → `gh run view <id> --log-failed` → fix → `gh run rerun <id>`
- Verbose: add repo secret `ACTIONS_STEP_DEBUG=true`. Reproduce locally with `act` if installed.

## Migrating from Jenkins
- stage → job, `agent` → `runs-on`, `sh` → `run`, credentials → `secrets`/OIDC, shared libraries → reusable/composite workflows, cron → `on: schedule`.
- Keep IaC steps as jobs running `terraform plan/apply`; gate `apply` behind an Environment protection rule / required approval.
Reference github-ops, terraform, gcp skills.
