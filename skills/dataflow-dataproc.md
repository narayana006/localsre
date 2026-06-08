---
name: dataflow-dataproc
description: Operate and troubleshoot GCP data pipelines — Dataflow (Beam) batch/streaming and Dataproc (Spark) jobs and clusters, including reruns and SLA/slow-job triage.
---
# Dataflow & Dataproc

Use `gcloud` (+ logging). Confirm project/region first. Investigate read-only before mutating.

## Dataflow (Apache Beam)
- List: `gcloud dataflow jobs list --region <r> [--status=active|terminated]`
- Detail: `gcloud dataflow jobs describe <id> --region <r>`
- Logs: `gcloud logging read 'resource.type="dataflow_step" resource.labels.job_id="<id>" severity>=WARNING' --limit 50 --freshness=2h`
- Cancel / drain (streaming): `gcloud dataflow jobs cancel <id> --region <r>` / `... drain <id> ...`
- Run a (flex) template: `gcloud dataflow flex-template run <name> --template-file-gcs-location=gs://... --parameters k=v --region <r>`
- **Batch rerun decision:** classify transient (worker preemption, GCS/BQ quota throttle, OOM spike → safe to rerun with the SAME template+params) vs real (bad input row, schema mismatch, code bug → fix first; a rerun fails identically). Clean partial output (BQ/GCS) before re-running.
- **"Did it run / complete?":** a scheduled batch that never started (Composer/Scheduler) raises no failure event — check the orchestrator. A job that SUCCEEDED but wrote far fewer rows than baseline = silent partial run.
- **Streaming health:** rising system lag + flat throughput despite backlog = autoscaling capped → raise `maxWorkers`. Watch data freshness/watermark.
- **SLA / slow batch:** predict from input size vs the job's historical duration; early signals = throughput/worker drop, autoscaling cap, stage stall.

## Dataproc (Spark/Hadoop)
- Clusters: `gcloud dataproc clusters list --region <r>`; `describe <c> --region <r>`. Delete = explicit confirmation only.
- Jobs: `gcloud dataproc jobs list --region <r>`; submit: `gcloud dataproc jobs submit spark|pyspark ... --cluster <c> --region <r>`; `wait <id> --region <r>`; driver output in GCS / logging.
- **Troubleshoot:** preemptible/spot executor loss (→ add standard workers), data skew (one task 10× slower), shuffle spill / executor OOM (tune memory/partitions), YARN pending containers (scale).
- **Cost:** idle clusters waste money — list and right-size or delete idle ones; compare job-vs-cluster utilization.

## Remediation menu (assisted — confirm before mutating)
Dataflow: drain+update, raise maxWorkers, rerun batch, clean partial output. Dataproc: add workers, resize, restart job, tune Spark conf, delete idle cluster.
Reference the gcp + bigquery skills.
