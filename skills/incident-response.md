---
name: incident-response
description: Triage production incidents end-to-end across PagerDuty, Datadog, GCP/GKE, and ServiceNow — gather signal, find likely cause, act, document.
---
# Incident response (SRE triage)

Turn a page into "what broke, why, what to do" fast. Combine the pagerduty, datadog, gcp, kubernetes, dataflow-dataproc, and servicenow skills.

## Triage loop
1. WHAT: pull the triggered incident (pagerduty skill) — service, time, severity.
2. SIGNAL: for that service + time window, pull Datadog metrics (error rate, latency, saturation) and error logs (datadog skill).
3. CHANGE: what changed? recent deploys/PRs (github-ops), GKE rollouts (`kubectl rollout history`), recent gcloud/Terraform changes. Most incidents follow a change.
4. CAUSE: correlate. Common: bad deploy, resource saturation (OOM/CPU), dependency failure, config/quota, or data-pipeline lag (dataflow-dataproc).
5. ACT (assisted — confirm before mutating): rollback the suspected change first (`kubectl rollout undo` / redeploy previous), scale (`kubectl scale`), restart, or raise a limit/quota. Prefer the least-destructive reversible action.
6. VERIFY: confirm the metrics recover and stay stable for 1–2 intervals.
7. DOCUMENT: update the PagerDuty incident notes and the ServiceNow incident (servicenow skill) with timeline, cause, and action taken.

## Useful one-liners
- Recent crashes/restarts: `kubectl get pods -A --sort-by=.status.startTime | tail`; `kubectl get events -A --sort-by=.lastTimestamp | tail -30`
- Who deployed last: `kubectl rollout history deploy/<name> -n <ns>`; `gh run list --workflow deploy`
- Error spike: Datadog logs search, or `gcloud logging read 'severity>=ERROR' --freshness=30m --limit 50`

Confirm cluster/project context before acting. Never take a destructive action to "fix" before confirming the cause.
