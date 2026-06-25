---
name: composer
description: Manage Google Cloud Composer (managed Airflow on GCP) environments, DAGs, DAG runs, and task instances via gcloud or the Airflow REST API.
---
# Google Cloud Composer

Auth: `gcloud auth application-default login` or service account with `roles/composer.user` + `roles/composer.environmentAndStorageObjectViewer`. Use `run_command` for all ops. Confirm project: `gcloud config get project`.

## Environments
- List: `gcloud composer environments list --locations=- --format="table(name,location,state)"`
- Describe: `gcloud composer environments describe <env> --location <region>`
- Get Airflow web UI URL: `gcloud composer environments describe <env> --location <region> --format="value(config.airflowUri)"`
- Get GCS DAG bucket: `gcloud composer environments describe <env> --location <region> --format="value(config.dagGcsPrefix)"`

## DAG Deployment
- Upload a DAG: `gsutil cp my_dag.py gs://<dag-bucket>/dags/`
- Remove a DAG: `gsutil rm gs://<dag-bucket>/dags/my_dag.py`
- DAGs sync within ~1-3 minutes after GCS upload.

## Airflow REST API
Get the Airflow host from `describe` above (`config.airflowUri`). Auth via `gcloud auth print-access-token`.

```
TOKEN=$(gcloud auth print-access-token)
BASE=https://<airflow-uri>/api/v1
curl -s -H "Authorization: Bearer $TOKEN" $BASE/<endpoint>
```

- List DAGs: `GET /dags?limit=50`
- DAG runs: `GET /dags/<dag_id>/dagRuns?order_by=-start_date&limit=10`
- Trigger run: `POST /dags/<dag_id>/dagRuns` body `{"conf":{}}`
- Task instances: `GET /dags/<dag_id>/dagRuns/<run_id>/taskInstances`
- Task logs: `GET /dags/<dag_id>/dagRuns/<run_id>/taskInstances/<task_id>/logs/1`
- Clear/retry task: `POST /dags/<dag_id>/dagRuns/<run_id>/taskInstances/clear` body `{"task_ids":["<task>"],"include_downstream":false}`
- Pause/unpause DAG: `PATCH /dags/<dag_id>` body `{"is_paused":true}`

## Logs (Cloud Logging)
- Scheduler logs: `gcloud logging read 'resource.type="cloud_composer_environment" logName=~"airflow-scheduler"' --limit 50 --format json`
- Worker/task logs: `gcloud logging read 'resource.type="cloud_composer_environment" labels."workflow"="<dag_id>"' --limit 50`
- Airflow errors: add `severity>=ERROR` to any filter above.

## Run Airflow CLI via gcloud
`gcloud composer environments run <env> --location <region> dags list`
`gcloud composer environments run <env> --location <region> tasks test <dag_id> <task_id> 2024-01-01`

Workflow for a failed DAG: `gcloud composer environments describe` → get Airflow URI + TOKEN → list failed dagRuns → fetch task instance logs → clear/retry. For infra issues check Cloud Logging scheduler logs. Pair with **gcp** skill for IAM/networking and **monitoring** skill for alerting.
