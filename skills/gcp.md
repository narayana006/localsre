---
name: gcp
description: Deploy to and troubleshoot Google Cloud across all major services — GKE, Cloud Run, Functions, Dataflow, Dataproc, Pub/Sub, BigQuery, GCS, Cloud SQL, Vertex AI, logging/monitoring, IAM.
---
# Google Cloud — deploy & troubleshoot

You have the FULL `gcloud`, `gsutil`/`gcloud storage`, `bq`, and `kubectl` CLIs — not just the commands below.
ALWAYS confirm context before acting: `gcloud auth list`, `gcloud config get-value project`, `gcloud config set project <id>`, and check the `--region`/`--zone`. Investigate read-only first; never delete projects/clusters/datasets without explicit confirmation.
ADC for SDKs: `gcloud auth application-default login`.

## Authentication — run these PROACTIVELY when you hit auth errors
If any command fails with "credentials"/401/403/"reauth required"/"not logged in", fix auth first, then retry:
- User login: `gcloud auth login` (interactive — opens a browser; tell the user to complete the browser flow, then retry).
- App/SDK auth (BigQuery, Vertex, client libs): `gcloud auth application-default login`.
- Service account (key file): `gcloud auth activate-service-account --key-file=<sa.json>`.
- IMPERSONATE a service account (no key needed — preferred): add `--impersonate-service-account=<sa>@<proj>.iam.gserviceaccount.com` to ANY gcloud command, or get a token: `gcloud auth print-access-token --impersonate-service-account=<sa>`. Requires `roles/iam.serviceAccountTokenCreator` on the SA. For client libraries/SDKs: `export GOOGLE_IMPERSONATE_SERVICE_ACCOUNT=<sa>` (or configure ADC impersonation). Verify with `gcloud auth print-access-token --impersonate-service-account=<sa>`.
- Verify: `gcloud auth list` (active account) and `gcloud auth print-access-token` (a token printing = authed).
These are interactive — after the user finishes the browser flow, re-run the original command.

## Discover any command (use when something isn't listed here)
- `gcloud help`, `gcloud <group> --help` (e.g. `gcloud compute instances --help`), `gcloud <group> <cmd> --help`
- `gcloud components list`; search: `gcloud <group> list` for any resource
- Add `--format=json` / `--format="value(...)"` to script output, `--filter='...'` to narrow.
Anything gcloud can do, you can do — look up the exact flags with `--help` rather than guessing.

## Logging (use for ANY service issue)
- `gcloud logging read '<filter>' --limit 50 --freshness=1h --format json`
- Errors only: `gcloud logging read 'severity>=ERROR' --limit 50 --freshness=1h`
- By resource: add `resource.type="<type>"` (e.g. `cloud_run_revision`, `k8s_container`, `dataflow_step`, `cloudsql_database`).

## GKE (Kubernetes)
- Connect: `gcloud container clusters get-credentials <cluster> --region <r>` → then use the **kubernetes** skill.
- Cluster health: `gcloud container clusters describe <cluster> --region <r>`; node pools: `gcloud container node-pools list --cluster <cluster> --region <r>`
- Troubleshoot: pod CrashLoop/Pending → kubernetes skill (describe/logs/events); node pressure → `kubectl top nodes`; image pull → check Artifact Registry IAM.

## Cloud Run
- Deploy: `gcloud run deploy <svc> --source . --region <r> --no-allow-unauthenticated` (ONLY add `--allow-unauthenticated` if the service is intentionally public — never by default; public endpoints on regulated infra are a security exposure)
- Inspect: `gcloud run services describe <svc> --region <r>`; `gcloud run revisions list --service <svc> --region <r>`
- Troubleshoot: 5xx/cold-start/timeouts → logs `resource.type=cloud_run_revision severity>=ERROR`; check memory/CPU limits, container port, and the startup probe.

## Cloud Functions
- Deploy: `gcloud functions deploy <fn> --gen2 --runtime python312 --trigger-http --region <r>`
- Logs: `gcloud functions logs read <fn> --region <r> --limit 50`

## Dataflow (Beam)
- List: `gcloud dataflow jobs list --region <r> --status=active`
- Detail: `gcloud dataflow jobs describe <id> --region <r>`
- Troubleshoot batch: failed step / bad input / OOM / quota → read worker logs (`resource.type=dataflow_step`); check autoscaling caps and the source/sink. For SLA/slow jobs compare elapsed vs input size and historical runs.

## Dataproc (Spark/Hadoop)
- Clusters: `gcloud dataproc clusters list --region <r>`; `gcloud dataproc clusters describe <c> --region <r>`
- Jobs: `gcloud dataproc jobs list --region <r>`; `gcloud dataproc jobs wait <id> --region <r>`; submit: `gcloud dataproc jobs submit spark ...`
- Troubleshoot: preemptible executor loss, data skew, shuffle spill, OOM, YARN pending containers; idle clusters waste money — check and right-size.

## Pub/Sub
- `gcloud pubsub topics list`; `gcloud pubsub subscriptions describe <sub>`
- Backlog/lag: check `num_undelivered_messages` (Monitoring) and `oldest_unacked_message_age`; pull a sample: `gcloud pubsub subscriptions pull <sub> --auto-ack --limit 5`

## BigQuery
- Query: `bq query --use_legacy_sql=false 'SELECT ...'`
- Inspect: `bq show <ds>.<table>`; `bq ls <ds>`; jobs: `bq ls -j -a --max_results 20`
- Troubleshoot: slow/expensive query → `bq show -j <jobid>` for bytes processed; check partitioning/clustering.

## Cloud Storage (GCS)
- `gcloud storage ls gs://<bucket>/`; copy: `gcloud storage cp <src> gs://<bucket>/`
- IAM: `gcloud storage buckets get-iam-policy gs://<bucket>`

## Cloud SQL
- `gcloud sql instances describe <inst>`; `gcloud sql operations list --instance <inst>`
- Connect: `gcloud sql connect <inst> --user=<u>`; troubleshoot: check connections, storage, and the cloud-sql-proxy.

## Vertex AI / LLMs
- SDK: `pip install google-cloud-aiplatform`
- List: `gcloud ai models list --region <r>`; `gcloud ai endpoints list --region <r>`
- Call Gemini:
  ```python
  import vertexai
  from vertexai.generative_models import GenerativeModel
  vertexai.init(project="<project-id>", location="us-central1")
  print(GenerativeModel("gemini-2.0-flash").generate_content("hello").text)
  ```
- REST: `TOKEN=$(gcloud auth print-access-token)` then POST with `Authorization: Bearer $TOKEN`.
- Auth: ADC or `GOOGLE_APPLICATION_CREDENTIALS=<sa-key.json>`. Troubleshoot 403 → check the SA has `roles/aiplatform.user`.

## IAM / quota (common root cause)
- `gcloud projects get-iam-policy <id>`; grant: `gcloud projects add-iam-policy-binding <id> --member=<m> --role=<role>`
- Quota errors → check the logged `status.code` and the quota in the console; many "permission" failures are a missing role on the runtime service account.

Verify every deploy with a follow-up `describe` or a curl to the service URL. Cross-reference the **kubernetes** and **python-env** skills as needed.
