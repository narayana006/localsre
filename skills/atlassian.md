---
name: atlassian
description: Work with Jira issues and Confluence pages via the Atlassian Cloud REST API.
---
# Atlassian (Jira & Confluence)

Auth: Basic auth with email + API token. `-u "$ATLASSIAN_EMAIL:$ATLASSIAN_API_TOKEN" -H "Content-Type: application/json"`.
Base: `https://<your-domain>.atlassian.net`. Use `run_command` with `curl` (+ `jq`).

## Jira
- Search (JQL): `GET /rest/api/3/search?jql=<encoded jql>&maxResults=25`
  - e.g. `project = SRE AND status != Done ORDER BY created DESC`
- Get issue: `GET /rest/api/3/issue/<KEY>`
- Create: `POST /rest/api/3/issue` body `{"fields":{"project":{"key":"SRE"},"summary":"...","issuetype":{"name":"Task"},"description":{...ADF...}}}`
- Comment: `POST /rest/api/3/issue/<KEY>/comment`
- Transition (e.g. to In Progress): `GET /rest/api/3/issue/<KEY>/transitions` to find the id, then `POST .../transitions` with `{"transition":{"id":"<id>"}}`
- Assign: `PUT /rest/api/3/issue/<KEY>/assignee` body `{"accountId":"<id>"}`

Note: Jira Cloud descriptions/comments use ADF (Atlassian Document Format) JSON, not plain markdown.

## Confluence
- Search: `GET /wiki/rest/api/content/search?cql=<cql>` (e.g. `type=page AND title~"runbook"`)
- Get page (with body): `GET /wiki/rest/api/content/<id>?expand=body.storage`
- Create page: `POST /wiki/rest/api/content` body `{"type":"page","title":"...","space":{"key":"<KEY>"},"body":{"storage":{"value":"<html>","representation":"storage"}}}`
- Update: `PUT /wiki/rest/api/content/<id>` (must include incremented `version.number`).

Workflow: pull/triage issues with JQL, enrich/transition them, and read runbooks from Confluence. Pair with **servicenow**, **pagerduty**, **datadog** for incident flows.
