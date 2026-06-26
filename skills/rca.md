---
name: rca
description: Root cause analysis and post-mortem — timeline reconstruction, contributing factors, proximate cause, true root cause, 5-why drill, prevention. Distinguish what triggered the incident from why the system allowed it. Trigger words: RCA, post-mortem, postmortem, outage, incident, root cause, retrospective, blameless, why did, what caused.
---
# Root cause analysis (RCA) playbook

Goal: produce a blameless, technically precise post-mortem that identifies the TRUE root cause (not just the trigger) and yields durable prevention actions.

Key distinction: **trigger** = the immediate event that started the incident. **Root cause** = the systemic gap that allowed the trigger to cause an outage. Fixing only the trigger prevents recurrence of this specific event — fixing the root cause prevents the whole class of failures.

## Step 1 — Collect raw timeline data

Pull all available sources. Do NOT interpret yet — just collect timestamps and facts:

```
# Monitoring / alerts
datadog_query kind=monitors  # when did alerts fire / recover?
datadog_query kind=metrics   # when did error rate / latency spike start and end?

# Deployment activity
gh run list --workflow deploy --limit 20
k8s_view "rollout history deploy/<svc> -n <ns>"
run_command git log --since="48 hours ago" --oneline --all

# System events
k8s_view "get events -n <ns> --sort-by=.lastTimestamp"
gcp_logs filter='severity>=ERROR' --freshness=24h --limit 100

# Human actions (chat/ticket records if available)
# Ask the user: "What actions were taken manually during the incident and when?"
```

If you don't have access to one of these sources, say so explicitly and note what's missing.

## Step 2 — Build the timeline

Reconstruct a chronological list of events. Format each entry as:

`HH:MM UTC — [SOURCE] — <factual event, no interpretation>`

Example:
```
14:03 UTC — [Datadog] — Error rate on payments-api crossed 5% (alert threshold)
14:05 UTC — [PagerDuty] — On-call engineer paged
14:07 UTC — [GKE rollout history] — payments-api v2.4.1 deployed (rollout started 13:58)
14:09 UTC — [Engineer] — Engineer acknowledged page, began investigation
14:22 UTC — [Engineer] — Rolled back to v2.4.0
14:25 UTC — [Datadog] — Error rate returned to < 0.1%
14:30 UTC — [Datadog] — Alert resolved
```

Note explicitly:
- When symptoms FIRST appeared (not when the alert fired — check metrics for the actual start)
- The gap between actual onset and detection
- The gap between detection and resolution

## Step 3 — Identify proximate cause

Proximate cause = the direct technical action/event that triggered the failure.

State it as: "The outage was triggered by X at time T."

Example: "The outage was triggered by the deployment of payments-api v2.4.1 at 13:58 UTC, which introduced a null pointer dereference in the charge handler."

This is usually obvious from the timeline. But verify: does removing this cause make the outage go away? (Rollback test, or logical reasoning if rollback already happened.)

## Step 4 — 5-Why drill to root cause

Start from the proximate cause. Ask "why was this possible?" five times or until you reach a systemic gap.

Do NOT stop at "human error". Humans make errors — the system should prevent those errors from causing outages.

Example drill:
1. Why did v2.4.1 cause errors? → The charge handler dereferenced `user.account` without null check.
2. Why did this reach production? → It passed CI — the null case wasn't covered by tests.
3. Why wasn't there a test for the null case? → The code path was added in a hotfix 3 weeks ago, bypassing normal PR review.
4. Why could a hotfix bypass PR review? → The repo policy allows direct push to `main` for `hotfix/*` branches with no review required.
5. Why does that policy exist? → It was set up 2 years ago for emergencies but was never time-limited or audited.

Root cause: **The branch protection policy exemption for hotfix branches allows unreviewed code to reach production, removing the last safety layer before deployment.**

The trigger was the null pointer bug. The root cause is the policy gap.

## Step 5 — Contributing factors

List conditions that made the incident worse than it needed to be (these are not the root cause but should also be addressed):

- Detection delay: alert threshold was 5% — symptoms were visible in metrics 3 minutes before alert.
- No canary / staged rollout — 100% traffic cut over immediately on deploy.
- On-call runbook didn't document how to roll back this service.
- The null pointer crash didn't have a specific error message — took 13 minutes to identify the cause.

## Step 6 — Impact statement

State concisely:
- Duration: from first symptom to full recovery (not from alert to recovery)
- Affected systems / users
- Quantified impact where possible: "Payment processing failed for ~8,400 requests over 22 minutes. $X in failed transactions."

Do NOT minimize impact. Accurate impact statements drive appropriate prevention investment.

## Step 7 — Prevention actions

For each action, specify:
- What: the concrete change
- Owner: role or team (not a specific person in a written RCA)
- When: deadline or sprint
- Does it fix the trigger, a contributing factor, or the root cause?

Mark each:
- (ROOT CAUSE) — prevents the whole class of failures
- (CONTRIBUTING) — reduces blast radius or detection time
- (TRIGGER) — prevents this specific bug from recurring

Example:
```
1. (ROOT CAUSE) Remove the branch protection exemption for hotfix/* branches. All merges to main require 1 approval. — Platform team — this week.
2. (ROOT CAUSE) Add a required CI check for null safety (linter rule or type check) for the payments service. — Backend team — 1 week.
3. (CONTRIBUTING) Add a canary deployment stage (10% traffic for 5 minutes) before full rollout. — Platform team — 2 weeks.
4. (CONTRIBUTING) Lower alert threshold from 5% to 1% error rate on payments-api. — Observability team — today.
5. (CONTRIBUTING) Add rollback steps to the payments-api runbook. — On-call engineer — today.
6. (TRIGGER) Add unit test for null `user.account` in charge handler. — Backend team — today.
```

## RCA report structure

```
## RCA — <incident title> — <date>

### Summary
<2–3 sentences: what broke, when, impact, root cause in plain language>

### Timeline (UTC)
<Step 2 output>

### Proximate Cause
<Step 3 — one sentence>

### Root Cause
<Step 4 — the systemic gap, not the bug>

### Contributing Factors
<Step 5 — bulleted list>

### Impact
<Step 6>

### Prevention Actions
<Step 7 table>

### What Went Well
<things that worked — fast detection, effective rollback, good comms — always include>
```

## Hard rules

- Blameless: name systems, processes, and configurations. Never name individuals as the cause.
- Separate trigger from root cause every time. If your root cause is "engineer made a mistake", drill deeper.
- Do not speculate in the timeline. Every entry needs a source.
- "We need better monitoring" is not an action. "Add an alert on payments-api error rate > 1% for 2 minutes" is an action.
- If you cannot determine root cause from available evidence: state what's unknown and what access would close the gap. Do not guess.
- Prevention actions must be specific and owned. Vague actions ("improve testing") are never completed.
