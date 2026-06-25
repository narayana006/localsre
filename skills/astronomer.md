---
name: astronomer
description: Manage Astronomer (managed Airflow) deployments, DAGs, DAG runs, and task instances via the Astro CLI or REST API.
---
# Astronomer

Auth: `ASTRO_API_TOKEN` (create at cloud.astronomer.io → API Tokens). Workspace and deployment IDs come from the UI URL or `astro deployment list`.

Astro CLI: `brew install astronomer/tap/astro` — use `run_command` for all CLI ops. Confirm workspace first: `astro workspace list`.

API base: `https://api.astronomer.io/v1alpha1`. Header: `-H "Authorization: Bearer $ASTRO_API_TOKEN"`.

## Deployments
- List: `astro deployment list`
- Detail: `astro deployment inspect <deployment-id>`
- Create/update: `astro deployment create` / `astro deployment update <id>`
- Logs (runtime): `astro deployment logs <id>`

## DAGs
- List DAGs in a deployment: `astro deployment dag list --deployment-id <id>`
- Trigger a DAG run: `astro deployment dag run <dag-id> --deployment-id <id>`
- Pause/unpause: `astro deployment dag pause/unpause <dag-id> --deployment-id <id>`
- Deploy code: `astro deploy <deployment-id>` (from Astro project root)

## DAG Runs & Task Instances (Airflow REST API on Astronomer)
Airflow API base: `https://<deployment-host>/api/v1` — get `<deployment-host>` from `astro deployment inspect`.
Auth: same `ASTRO_API_TOKEN` as Bearer.

- DAG runs: `GET /dags/<dag_id>/dagRuns?limit=10&order_by=-start_date`
- Trigger run: `POST /dags/<dag_id>/dagRuns` body `{"conf":{}}`
- Task instances: `GET /dags/<dag_id>/dagRuns/<run_id>/taskInstances`
- Task logs: `GET /dags/<dag_id>/dagRuns/<run_id>/taskInstances/<task_id>/logs/1`
- Clear task (retry): `POST /dags/<dag_id>/dagRuns/<run_id>/taskInstances/clear` body `{"task_ids":["<task_id>"],"include_downstream":false}`

## Alerts & Monitoring
- Deployment alerts: `astro deployment alert list --deployment-id <id>`
- Metrics: available in Astronomer UI under Deployment → Metrics (Prometheus-backed)

Workflow for a failed DAG: `astro deployment list` → get Airflow API host → list recent dagRuns filtered by `state=failed` → fetch task instance logs → clear/retry the failed task. Pair with **monitoring** skill for infra-side signals.
