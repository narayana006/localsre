---
name: bigquery
description: Query, explore, and analyze data in BigQuery — bq CLI, GoogleSQL, schema discovery, cost control, partitioning, joins, exports.
---
# BigQuery — querying & data analysis

Primary tool: the `bq` CLI (and `gcloud`). Always confirm project: `bq --project_id=<id> ...` or `gcloud config set project <id>`. Use GoogleSQL (standard SQL): `--use_legacy_sql=false`.

## Discover the data first (don't guess schema)
- Datasets: `bq ls` ; tables: `bq ls <dataset>`
- Schema + metadata: `bq show --format=prettyjson <dataset>.<table>`
- Columns via INFORMATION_SCHEMA: `bq query --use_legacy_sql=false 'SELECT column_name,data_type FROM `<ds>`.INFORMATION_SCHEMA.COLUMNS WHERE table_name="<t>"'`
- Sample rows: `bq query --use_legacy_sql=false 'SELECT * FROM `<proj>.<ds>.<t>` LIMIT 10'`
- Row count / size: `bq show --format=prettyjson <ds>.<t>` (numRows, numBytes) — cheaper than `COUNT(*)`.

## Run queries (always cost-aware — BigQuery bills by bytes scanned)
- Dry run (estimate bytes, $0): `bq query --use_legacy_sql=false --dry_run 'SELECT ...'`
- Cap cost: `bq query --use_legacy_sql=false --maximum_bytes_billed=1000000000 'SELECT ...'`
- SELECT only the columns you need (never `SELECT *` on big tables — it scans every column).
- Filter on the PARTITION column to prune scans: `WHERE _PARTITIONDATE BETWEEN "2026-06-01" AND "2026-06-07"` (or the table's partition field, e.g. `DATE(event_ts)`).
- Preview without a query (free): `bq head -n 20 <ds>.<t>`

## GoogleSQL patterns
- Date/time: `TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)`, `DATE(ts)`, `FORMAT_TIMESTAMP('%F %T', ts)`, `TIMESTAMP_DIFF(a,b,SECOND)`
- Aggregation: `GROUP BY`, `COUNT(*)`, `COUNTIF(cond)`, `APPROX_COUNT_DISTINCT(x)`, `SUM/AVG`, `ANY_VALUE(x)`
- Window: `ROW_NUMBER() OVER (PARTITION BY user ORDER BY ts DESC)`, `SUM(x) OVER (...)`, `LAG/LEAD`
- Arrays/structs: `UNNEST(arr)`, `ARRAY_AGG(x ORDER BY ts)`, `STRUCT(...)`, dotted access `record.field`
- Dedup latest row per key: `QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY ts DESC)=1`
- Joins: prefer explicit `JOIN ... ON`; broadcast small tables; watch for fan-out on one-to-many joins.
- CTEs for readability: `WITH base AS (...) SELECT ... FROM base`

## Export / move data
- Query to a table: `bq query --use_legacy_sql=false --destination_table=<ds>.<out> --replace 'SELECT ...'`
- Table to GCS: `bq extract --destination_format=CSV <ds>.<t> gs://<bucket>/out-*.csv`
- Query to local: `bq query --use_legacy_sql=false --format=csv 'SELECT ...' > out.csv`
- Load from GCS: `bq load --source_format=CSV <ds>.<t> gs://<bucket>/file.csv schema.json`

## SRE data patterns
- Error rate over time: `SELECT TIMESTAMP_TRUNC(ts,MINUTE) m, COUNTIF(status>=500)/COUNT(*) err_rate FROM logs WHERE ts>TIMESTAMP_SUB(CURRENT_TIMESTAMP(),INTERVAL 1 HOUR) GROUP BY m ORDER BY m`
- Top offenders: `... GROUP BY service ORDER BY error_count DESC LIMIT 20`
- Job/pipeline auditing: query `region-<r>`.INFORMATION_SCHEMA.JOBS for expensive queries (bytes processed, user).

## Workflow
1. Discover schema (INFORMATION_SCHEMA / show) before writing SQL.
2. Build the query; `--dry_run` to check bytes/cost.
3. Run with `--maximum_bytes_billed` as a guardrail on large tables.
4. Validate the result; refine. Explain costs if a query would scan a lot.
Cross-reference the **gcp** skill for auth and the **python-env** skill if using the `google-cloud-bigquery` Python client.
