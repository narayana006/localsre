---
name: datadog
description: Query Datadog metrics, monitors, logs, events, and dashboards via the API or the `dog` CLI.
---
# Datadog

Auth via env: `DD_API_KEY`, `DD_APP_KEY` (and `DD_SITE`, e.g. `datadoghq.com`). The agent can `export` them or read from the project env. Use `run_command` with `curl`, or the `dog`/`datadog-ci` CLIs if installed (`pip install datadog`).

API base: `https://api.${DD_SITE:-datadoghq.com}/api`. Headers: `-H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY"`.

## Monitors
- List: `curl -s "https://api.$DD_SITE/api/v1/monitor" -H ...`
- Alerting only: filter `... | jq '.[] | select(.overall_state=="Alert") | {id,name}'`
- Detail: `GET /api/v1/monitor/<id>`

## Metrics (timeseries query)
- `GET /api/v1/query?from=<epoch>&to=<epoch>&query=<metric{tags}>` — e.g. `avg:system.cpu.user{service:checkout}`
- Use this to pull error rate / latency / saturation when investigating an incident.

## Logs
- `POST /api/v2/logs/events/search` with body `{"filter":{"query":"service:checkout status:error","from":"now-1h","to":"now"},"page":{"limit":25}}`

## Events
- `GET /api/v1/events?start=<epoch>&end=<epoch>` — deploys, alerts, etc.

## Dashboards
- List: `GET /api/v1/dashboard`; detail: `GET /api/v1/dashboard/<id>`

Workflow for an incident: find alerting monitor → pull the relevant metric timeseries → search error logs for that service/time window → summarize likely cause. Pair with the **pagerduty** skill.
