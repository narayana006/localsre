---
name: redis
description: Inspect and troubleshoot Redis / ElastiCache — connections, memory, keyspace, slow log, replication, cluster health — via redis-cli or AWS CLI.
---
# Redis

Connect: `redis-cli -h <host> -p 6379 [-a <password>]` or with TLS: `redis-cli -h <host> -p 6380 --tls`. Use `run_command` for all ops. For AWS ElastiCache, get the endpoint from `aws elasticache describe-replication-groups` or `describe-cache-clusters`.

## Health check (always start here)
- `redis-cli -h <host> ping` — should return PONG
- `redis-cli -h <host> info server | grep -E 'redis_version|uptime|os'`
- `redis-cli -h <host> info replication` — role, connected_slaves, master_link_status
- `redis-cli -h <host> info stats | grep -E 'total_commands|rejected_connections|keyspace_hits|keyspace_misses'`

## Memory
- `redis-cli -h <host> info memory` — used_memory_human, mem_fragmentation_ratio (>1.5 = fragmentation issue)
- `redis-cli -h <host> memory doctor` — Redis's own diagnosis
- `redis-cli -h <host> dbsize` — total key count
- Max memory policy: `redis-cli -h <host> config get maxmemory-policy`
- Large keys (top 10 by memory): `redis-cli -h <host> --memkeys --memkeys-samples 200 | head -20`

## Keyspace & keys
- `redis-cli -h <host> info keyspace` — db, key count, expiring keys, avg TTL
- Find keys (use carefully on prod — SCAN not KEYS): `redis-cli -h <host> --scan --pattern "session:*" | head -20`
- Inspect a key: `redis-cli -h <host> type <key>` then `get/hgetall/lrange/smembers/zrange` depending on type
- TTL: `redis-cli -h <host> ttl <key>` (−1 = no expiry, −2 = doesn't exist)
- Delete safely: `redis-cli -h <host> unlink <key>` (async, non-blocking)

## Connections & clients
- `redis-cli -h <host> info clients` — connected_clients, blocked_clients, tracking_clients
- `redis-cli -h <host> client list` — all connected clients with addr/cmd/age
- Kill a client: `redis-cli -h <host> client kill id <client-id>`

## Slow log
- `redis-cli -h <host> slowlog get 20` — last 20 slow commands (time in microseconds)
- `redis-cli -h <host> slowlog len` — total slow log entries
- `redis-cli -h <host> config get slowlog-log-slower-than` — threshold (default 10000 µs = 10ms)

## Replication & cluster
- Replication info: `redis-cli -h <host> info replication`
- Cluster nodes: `redis-cli -h <host> cluster nodes` (cluster mode only)
- Cluster info: `redis-cli -h <host> cluster info`
- Failover (replica to master): `redis-cli -h <replica-host> cluster failover` or `redis-cli -h <sentinel-host> -p 26379 sentinel failover <master-name>`

## AWS ElastiCache specifics
- List clusters: `aws elasticache describe-replication-groups --query 'ReplicationGroups[*].[ReplicationGroupId,Status,NodeGroups[0].PrimaryEndpoint.Address]' --output table`
- Events: `aws elasticache describe-events --duration 60`
- Metrics (CloudWatch namespace `AWS/ElastiCache`): CurrConnections, Evictions, CacheHits, CacheMisses, FreeableMemory, ReplicationLag

## Common issues
| Symptom | Check |
|---|---|
| High memory / evictions | `info memory` + `maxmemory-policy`; identify large/hot keys with `--memkeys` |
| Latency spikes | `slowlog get 20`; check fragmentation ratio; look for KEYS/SORT/LRANGE on huge lists |
| Connection errors | `info clients`; check `maxclients` (`config get maxclients`); check network/SG |
| Replication lag | `info replication` → `master_repl_offset` vs `slave_repl_offset`; check network bandwidth |
| Cache miss rate high | `info stats` keyspace_hits vs keyspace_misses; review TTLs and eviction policy |

Pair with **postgresql** (if Redis is used as a cache in front of Postgres) or **kubernetes** (if running Redis via a StatefulSet).
