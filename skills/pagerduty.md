---
name: pagerduty
description: List, acknowledge, resolve PagerDuty incidents and check on-call schedules via the API or `pd` CLI.
---
# PagerDuty

Auth: REST API token in `PD_API_TOKEN`. Header: `-H "Authorization: Token token=$PD_API_TOKEN" -H "Content-Type: application/json"`. Base: `https://api.pagerduty.com`. CLI alternative: `pd` (pagerduty-cli).

## Incidents
- List open: `curl -s "https://api.pagerduty.com/incidents?statuses[]=triggered&statuses[]=acknowledged" -H ... | jq '.incidents[] | {id,title,status,urgency}'`
- Detail: `GET /incidents/<id>`; notes: `GET /incidents/<id>/notes`; log: `GET /incidents/<id>/log_entries`
- Acknowledge / resolve (needs `From: <user-email>` header):
  `PUT /incidents/<id>` body `{"incident":{"type":"incident_reference","status":"acknowledged"}}` (or `"resolved"`)
- Add note: `POST /incidents/<id>/notes` body `{"note":{"content":"..."}}`

## On-call
- Who's on call: `GET /oncalls?escalation_policy_ids[]=<id>` → `.oncalls[].user.summary`
- Schedules: `GET /schedules`

## Services
- `GET /services` — map a service to its escalation policy.

Incident workflow: pull the triggered incident → read its log/notes → correlate with the **datadog** skill (metrics+logs for that service+time) → propose a cause and (with approval) acknowledge + add a note. Never auto-resolve without confirmation.
