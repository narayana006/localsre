---
name: postgresql
description: Inspect and troubleshoot PostgreSQL / RDS Postgres — slow queries, locks, connections, vacuum, replication, schema — via psql or AWS CLI.
---
# PostgreSQL

Connect: `psql "postgresql://<user>:<pass>@<host>:5432/<db>"` or `psql -h <host> -U <user> -d <db>`. Use `run_command`. For AWS RDS, get endpoint from `aws rds describe-db-instances`. For GCP Cloud SQL use `gcloud sql connect`.

Set a statement timeout for safety on prod: `SET statement_timeout = '30s';`

## Health check (start here)
```sql
SELECT version();
SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size;
SELECT count(*) FROM pg_stat_activity WHERE state != 'idle';
SELECT now() - pg_postmaster_start_time() AS uptime;
```

## Connections
```sql
-- Current connections by state and user
SELECT state, usename, count(*) FROM pg_stat_activity GROUP BY state, usename ORDER BY count DESC;
-- Max connections vs used
SELECT setting::int AS max_conn FROM pg_settings WHERE name='max_connections';
-- Kill idle connections older than 10 min
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
  WHERE state='idle' AND query_start < now() - interval '10 min' AND pid <> pg_backend_pid();
```

## Slow queries
```sql
-- Top 10 slowest queries (requires pg_stat_statements extension)
SELECT query, calls, round(mean_exec_time::numeric,2) AS avg_ms,
       round(total_exec_time::numeric,2) AS total_ms, rows
FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 10;

-- Currently running queries > 5s
SELECT pid, now()-query_start AS duration, state, query
FROM pg_stat_activity WHERE state != 'idle' AND query_start < now()-interval '5s'
ORDER BY duration DESC;
```

## Locks & blocking
```sql
-- Blocked queries and what's blocking them
SELECT blocked.pid, blocked.query AS blocked_query,
       blocking.pid AS blocking_pid, blocking.query AS blocking_query
FROM pg_stat_activity blocked
JOIN pg_stat_activity blocking ON blocking.pid = ANY(pg_blocking_pids(blocked.pid))
WHERE blocked.cardinality(pg_blocking_pids(blocked.pid)) > 0;

-- Kill a blocking pid (confirm with user first)
SELECT pg_terminate_backend(<pid>);
```

## Table & index stats
```sql
-- Largest tables
SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) AS size
FROM pg_class WHERE relkind='r' ORDER BY pg_total_relation_size(oid) DESC LIMIT 10;

-- Sequential scans (missing index candidates)
SELECT relname, seq_scan, idx_scan, seq_tup_read
FROM pg_stat_user_tables WHERE seq_scan > 100 ORDER BY seq_scan DESC LIMIT 20;

-- Unused indexes (waste of write amplification)
SELECT schemaname, tablename, indexname, idx_scan
FROM pg_stat_user_indexes WHERE idx_scan = 0 AND schemaname='public' ORDER BY tablename;
```

## Vacuum & bloat
```sql
-- Tables needing vacuum
SELECT relname, n_dead_tup, last_autovacuum, last_analyze
FROM pg_stat_user_tables WHERE n_dead_tup > 10000 ORDER BY n_dead_tup DESC LIMIT 10;

-- Manually vacuum (non-blocking)
VACUUM (VERBOSE, ANALYZE) <table>;
-- VACUUM FULL (locks table — confirm with user, do during maintenance window)
```

## Replication (streaming)
```sql
-- On primary: replication lag per replica
SELECT client_addr, state, sent_lsn, write_lsn, flush_lsn, replay_lsn,
       (sent_lsn - replay_lsn) AS lag_bytes
FROM pg_stat_replication;

-- On replica: lag from primary
SELECT now() - pg_last_xact_replay_timestamp() AS replication_lag;
SELECT pg_is_in_recovery(); -- true = this is a replica
```

## Schema inspection
```sql
-- Tables in schema
\dt public.*
-- Columns
\d <table>
-- Indexes
\di <table>
-- Explain a query
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) <your query>;
```

## AWS RDS specifics
- Performance Insights: `aws pi get-resource-metrics --service-type RDS --identifier db:<id> --metric-queries '[{"Metric":"db.load.avg"}]' --start-time $(date -u -v-1H +%s) --end-time $(date -u +%s) --period-in-seconds 60`
- Events: `aws rds describe-events --source-identifier <db-id> --source-type db-instance --duration 60`
- Logs: `aws rds download-db-log-file-portion --db-instance-identifier <id> --log-file-name error/postgresql.log --starting-token 0`
- CloudWatch metrics (namespace `AWS/RDS`): DatabaseConnections, FreeStorageSpace, ReadLatency, WriteLatency, CPUUtilization

## Common issues
| Symptom | Check |
|---|---|
| Connection exhausted | `pg_stat_activity` count vs `max_connections`; add PgBouncer pooling |
| Slow query | `pg_stat_statements` avg_ms; `EXPLAIN ANALYZE`; check for seq scans / missing index |
| Table bloat / dead tuples | `pg_stat_user_tables` n_dead_tup; run `VACUUM ANALYZE` |
| Lock wait / deadlock | `pg_blocking_pids()`; check long-running transactions |
| Replication lag | `pg_stat_replication` lag_bytes; check replica I/O, network, or long txns on primary |

Pair with **aws** (RDS), **gcp** (Cloud SQL), or **redis** (if Postgres is fronted by a Redis cache).
