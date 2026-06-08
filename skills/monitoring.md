---
name: monitoring
description: GCP Cloud Monitoring & Logging — create/manage alert policies, query metrics (time series), read logs, log-based metrics, notification channels, uptime checks.
---
# GCP Cloud Monitoring & Logging

Use `gcloud` + the Monitoring/Logging APIs (`curl` with `gcloud auth print-access-token`). Confirm project first.

## Read logs (Cloud Logging)
- `gcloud logging read '<filter>' --limit 50 --freshness=1h --format json`
  - by resource: `resource.type="k8s_container" resource.labels.namespace_name="prod"`
  - errors: `severity>=ERROR`; substring: `"timeout"`; HTTP 5xx: `httpRequest.status>=500`
- Stream/tail: `gcloud logging tail '<filter>'`
- List logs: `gcloud logging logs list`

## Check metrics (time series)
- List metric types: `gcloud monitoring metrics-descriptors list --filter="metric.type=starts_with('compute.googleapis.com')"`
- Read a time series via API:
  ```bash
  TOKEN=$(gcloud auth print-access-token); PROJ=$(gcloud config get-value project)
  curl -s -H "Authorization: Bearer $TOKEN" \
    "https://monitoring.googleapis.com/v3/projects/$PROJ/timeSeries?filter=metric.type=%22compute.googleapis.com/instance/cpu/utilization%22&interval.startTime=$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)&interval.endTime=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  ```
- Common SRE metrics: CPU/memory utilization, request_count, latency, error rate, Pub/Sub `num_undelivered_messages`, Dataflow system lag.

## Create / manage alert policies
- List: `gcloud alpha monitoring policies list`
- Describe: `gcloud alpha monitoring policies describe <policy-id>`
- Create from file: `gcloud alpha monitoring policies create --policy-from-file=policy.json`
  - policy.json: `displayName`, `conditions[].conditionThreshold` (filter, comparison e.g. COMPARISON_GT, thresholdValue, duration, aggregations), `combiner`, `notificationChannels`, `alertStrategy`.
- Update: `gcloud alpha monitoring policies update <id> --policy-from-file=policy.json`
- Delete (confirm first): `gcloud alpha monitoring policies delete <id>`

## Notification channels & extras
- Channels: `gcloud alpha monitoring channels list`; `gcloud alpha monitoring channels create --channel-content-from-file=channel.json` (email/PagerDuty/Slack) → reference the returned name in the policy's `notificationChannels`.
- Log-based metric: `gcloud logging metrics create <name> --description="..." --log-filter='<filter>'` (then alert on it).
- Uptime check: `gcloud monitoring uptime create ...`.

## Workflow to create an alert
1. Pick the metric (`metrics-descriptors list`) and confirm it has data (timeSeries read).
2. Write policy.json (condition filter + threshold + duration + aggregation, combiner, notificationChannels).
3. `gcloud alpha monitoring policies create --policy-from-file=policy.json`; verify with `policies describe`.
Reference the gcp, datadog, and dataflow-dataproc skills.
