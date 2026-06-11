---
name: investigate
description: Investigate a service/incident end-to-end — correlate Datadog symptoms, Kubernetes runtime state, GCP logs, and recent changes into a ranked hypothesis. Trigger words: investigate, incident, outage, "why is X failing/slow/erroring".
---
# Incident investigation playbook (read-only)

Goal: from "investigate service X" to a ranked root-cause hypothesis WITH evidence. Use update_plan first. Stay read-only — propose actions, never execute mutations without the user.

## 1. Symptoms (what is wrong, since when)
- datadog_query kind=monitors → which monitors are ALERTING for the service.
- datadog_query kind=metrics → error rate / latency / throughput for the service, last 60–120m. Note WHEN it started.
- datadog_query kind=logs query="service:<x> status:error" → top error messages.

## 2. Runtime truth (Kubernetes)
- k8s_view "get pods -n <ns> -o wide" → restarts? CrashLoopBackOff? Pending? recent AGE (= recent deploy)?
- k8s_view "get events -n <ns> --sort-by=.lastTimestamp" → OOMKilled, probe failures, scheduling issues.
- k8s_view "logs deploy/<x> -n <ns> --tail=100" (and --previous if restarting) → stack traces.
- k8s_view "get deploy <x> -n <ns>" → replicas ready vs desired; rollout revision.

## 3. Platform logs (GCP)
- gcp_logs filter='resource.type="k8s_container" resource.labels.namespace_name="<ns>" severity>=ERROR' → infra-level errors the app logs miss.

## 4. What changed (the usual culprit)
- run_command: gh pr list --repo <org/repo> --state merged --limit 10  (or git log --since="4 hours ago")
- k8s_view "rollout history deploy/<x> -n <ns>" → did a rollout land near symptom start?
- If a stack trace names a file/function: search_code it, read the recent diff of that file.

## 5. Correlate → hypothesize → report
Build a short TIMELINE (symptom start vs deploys/changes/events). Then report:
- **Hypothesis (ranked)** — most likely cause with the evidence lines that support it
- **Confidence** — high / medium / low based on evidence strength
- **Suggested action** — e.g. rollback revision N, scale up, fix function f() in file.py (PROPOSE only)
- **What would confirm it** — the one check that would prove/disprove

If evidence is thin, say so explicitly and list what access/data is missing. Save durable findings with remember.
