// 100 SRE scenarios across 10 domains. Each has expected keywords (accuracy signal)
// and an anti-pattern list (hallucination/wrong-answer signal).
// expect: response should contain at least `minHits` of these (case-insensitive).
// avoid:  response should contain NONE of these (wrong command / fabrication).
module.exports = [
  // ── Kubernetes (1-15) ──
  { id: 1, cat: "k8s", q: "A pod is stuck in CrashLoopBackOff. What is the single most useful first command to see why?", expect: ["kubectl logs", "--previous", "-p", "describe"], minHits: 1 },
  { id: 2, cat: "k8s", q: "How do you see the last logs from a container that already restarted?", expect: ["kubectl logs", "--previous", "-p"], minHits: 2 },
  { id: 3, cat: "k8s", q: "A pod is Pending and never schedules. What command shows the scheduling reason?", expect: ["kubectl describe", "events", "Insufficient", "taint", "nodeSelector"], minHits: 2 },
  { id: 4, cat: "k8s", q: "How do you check resource requests vs actual usage for pods on a node?", expect: ["kubectl top", "describe node", "requests", "limits"], minHits: 1 },
  { id: 5, cat: "k8s", q: "What does OOMKilled mean and which field controls it?", expect: ["memory", "limit", "out of memory", "resources.limits"], minHits: 2 },
  { id: 6, cat: "k8s", q: "How do you roll back a Deployment to the previous revision?", expect: ["kubectl rollout undo", "rollout history"], minHits: 1 },
  { id: 7, cat: "k8s", q: "A Service has no endpoints. What is the most likely cause?", expect: ["selector", "label", "pod", "match", "readiness"], minHits: 2 },
  { id: 8, cat: "k8s", q: "How do you exec into a running pod to debug?", expect: ["kubectl exec", "-it", "/bin/sh", "bash"], minHits: 2 },
  { id: 9, cat: "k8s", q: "How do you see events sorted by time in a namespace?", expect: ["kubectl get events", "--sort-by", "lastTimestamp", ".metadata.creationTimestamp"], minHits: 2 },
  { id: 10, cat: "k8s", q: "A readinessProbe is failing. Where do you look first?", expect: ["describe", "events", "probe", "logs", "port", "path"], minHits: 2 },
  { id: 11, cat: "k8s", q: "How do you cordon and drain a node for maintenance?", expect: ["kubectl cordon", "kubectl drain", "--ignore-daemonsets"], minHits: 2 },
  { id: 12, cat: "k8s", q: "How do you check which container in a multi-container pod is restarting?", expect: ["kubectl describe", "RESTARTS", "kubectl get pod", "-c", "logs"], minHits: 1 },
  { id: 13, cat: "k8s", q: "What causes ImagePullBackOff?", expect: ["image", "registry", "credentials", "imagePullSecret", "tag", "not found"], minHits: 2 },
  { id: 14, cat: "k8s", q: "How do you see the YAML of a running deployment?", expect: ["kubectl get deployment", "-o yaml", "-o=yaml"], minHits: 2 },
  { id: 15, cat: "k8s", q: "How do you scale a deployment to 5 replicas?", expect: ["kubectl scale", "--replicas=5", "replicas"], minHits: 2 },

  // ── Incident response (16-28) ──
  { id: 16, cat: "incident", q: "Production is down. What are the first three steps of incident response?", expect: ["acknowledge", "assess", "mitigate", "communicate", "rollback", "severity", "page"], minHits: 2 },
  { id: 17, cat: "incident", q: "A deploy just went out and errors spiked. What is the fastest mitigation?", expect: ["rollback", "revert", "previous", "roll back"], minHits: 1 },
  { id: 18, cat: "incident", q: "What is the difference between a trigger and a root cause?", expect: ["trigger", "root cause", "underlying", "immediate", "initiated"], minHits: 2 },
  { id: 19, cat: "incident", q: "During an outage, what should you communicate and to whom?", expect: ["status", "stakeholders", "updates", "customers", "channel", "impact", "ETA"], minHits: 2 },
  { id: 20, cat: "incident", q: "What is an error budget and how is it used?", expect: ["SLO", "reliability", "budget", "downtime", "allowed", "spend"], minHits: 2 },
  { id: 21, cat: "incident", q: "How do you decide incident severity (SEV1 vs SEV3)?", expect: ["impact", "customer", "scope", "revenue", "users affected", "critical"], minHits: 2 },
  { id: 22, cat: "incident", q: "What goes into a blameless post-mortem?", expect: ["timeline", "root cause", "impact", "action items", "blameless", "lessons"], minHits: 2 },
  { id: 23, cat: "incident", q: "Latency p99 doubled but p50 is fine. What does that suggest?", expect: ["tail", "outlier", "subset", "GC", "contention", "some requests", "p99"], minHits: 1 },
  { id: 24, cat: "incident", q: "What is the on-call golden rule when you do not understand an alert?", expect: ["escalate", "ask", "runbook", "don't guess", "page"], minHits: 1 },
  { id: 25, cat: "incident", q: "A dependency is timing out. What two patterns protect your service?", expect: ["circuit breaker", "timeout", "retry", "fallback", "bulkhead"], minHits: 2 },
  { id: 26, cat: "incident", q: "What metric tells you a service is saturated?", expect: ["CPU", "queue", "latency", "utilization", "saturation", "throughput"], minHits: 2 },
  { id: 27, cat: "incident", q: "What are the four golden signals of monitoring?", expect: ["latency", "traffic", "errors", "saturation"], minHits: 3 },
  { id: 28, cat: "incident", q: "After mitigating, what must you do before closing the incident?", expect: ["verify", "monitor", "confirm", "post-mortem", "follow-up", "recovered"], minHits: 2 },

  // ── Linux/systems (29-43) ──
  { id: 29, cat: "linux", q: "A disk is full. How do you find the largest directories?", expect: ["du", "-sh", "du -ah", "sort", "ncdu"], minHits: 1 },
  { id: 30, cat: "linux", q: "How do you see what process is listening on port 8080?", expect: ["lsof", "-i :8080", "netstat", "ss -ltnp", "ss "], minHits: 1 },
  { id: 31, cat: "linux", q: "A process is using 100% CPU. How do you find it?", expect: ["top", "htop", "ps aux", "--sort"], minHits: 1 },
  { id: 32, cat: "linux", q: "How do you see disk space usage by filesystem?", expect: ["df -h", "df"], minHits: 1 },
  { id: 33, cat: "linux", q: "How do you tail and follow a log file in real time?", expect: ["tail -f", "tail -F"], minHits: 1 },
  { id: 34, cat: "linux", q: "How do you check memory usage including swap?", expect: ["free -h", "free -m", "free", "vmstat"], minHits: 1 },
  { id: 35, cat: "linux", q: "How do you find files modified in the last 24 hours?", expect: ["find", "-mtime", "-mmin", "-1"], minHits: 2 },
  { id: 36, cat: "linux", q: "A service won't start under systemd. How do you see why?", expect: ["systemctl status", "journalctl", "-u", "-xe"], minHits: 2 },
  { id: 37, cat: "linux", q: "How do you check open file descriptor limits for a process?", expect: ["ulimit", "-n", "/proc", "limits", "lsof"], minHits: 1 },
  { id: 38, cat: "linux", q: "How do you search recursively for a string in files?", expect: ["grep -r", "grep -rn", "rg", "ripgrep"], minHits: 1 },
  { id: 39, cat: "linux", q: "How do you see the last 50 lines of kernel messages?", expect: ["dmesg", "journalctl -k", "tail"], minHits: 1 },
  { id: 40, cat: "linux", q: "How do you kill a process by name?", expect: ["pkill", "killall", "kill", "pgrep"], minHits: 1 },
  { id: 41, cat: "linux", q: "How do you check what is consuming inodes when df shows space but writes fail?", expect: ["df -i", "inode", "find", "-type f"], minHits: 1 },
  { id: 42, cat: "linux", q: "How do you see established network connections?", expect: ["ss", "netstat", "-tn", "-an"], minHits: 1 },
  { id: 43, cat: "linux", q: "How do you measure how long a command takes?", expect: ["time ", "/usr/bin/time"], minHits: 1 },

  // ── Networking (44-54) ──
  { id: 44, cat: "network", q: "A service can't reach another over DNS. How do you test resolution?", expect: ["dig", "nslookup", "host ", "getent"], minHits: 1 },
  { id: 45, cat: "network", q: "How do you test if a TCP port is open on a remote host?", expect: ["nc -zv", "telnet", "nc ", "/dev/tcp", "curl"], minHits: 1 },
  { id: 46, cat: "network", q: "What does a 502 Bad Gateway from nginx usually mean?", expect: ["upstream", "backend", "down", "unreachable", "connection refused"], minHits: 2 },
  { id: 47, cat: "network", q: "What does a 504 Gateway Timeout indicate?", expect: ["timeout", "upstream", "backend", "slow", "no response"], minHits: 2 },
  { id: 48, cat: "network", q: "How do you trace the network path to a host?", expect: ["traceroute", "tracepath", "mtr"], minHits: 1 },
  { id: 49, cat: "network", q: "How do you inspect HTTP response headers from the command line?", expect: ["curl -I", "curl -v", "-D -", "headers"], minHits: 1 },
  { id: 50, cat: "network", q: "Connections hang with no response. What firewall behavior causes this vs a refused connection?", expect: ["drop", "DROP", "REJECT", "silently", "no response", "timeout"], minHits: 2 },
  { id: 51, cat: "network", q: "What is MTU and what symptom does a mismatch cause?", expect: ["maximum transmission unit", "fragment", "hang", "large packets", "MTU"], minHits: 2 },
  { id: 52, cat: "network", q: "How do you see the routing table on Linux?", expect: ["ip route", "route -n", "netstat -rn"], minHits: 1 },
  { id: 53, cat: "network", q: "TLS handshake fails. How do you inspect the cert a server presents?", expect: ["openssl s_client", "-connect", "openssl"], minHits: 1 },
  { id: 54, cat: "network", q: "What is the difference between a load balancer health check passing but users seeing errors?", expect: ["health check", "shallow", "deep", "endpoint", "dependency", "different path"], minHits: 1 },

  // ── Databases (55-64) ──
  { id: 55, cat: "db", q: "PostgreSQL queries suddenly got slow. What do you check first?", expect: ["EXPLAIN", "ANALYZE", "pg_stat_activity", "index", "locks", "vacuum"], minHits: 2 },
  { id: 56, cat: "db", q: "How do you find currently running queries in PostgreSQL?", expect: ["pg_stat_activity", "SELECT", "state", "query"], minHits: 1 },
  { id: 57, cat: "db", q: "What causes connection pool exhaustion and how do you confirm it?", expect: ["max_connections", "pool", "idle", "leak", "pg_stat_activity", "too many"], minHits: 2 },
  { id: 58, cat: "db", q: "A query does a sequential scan on a large table. What likely fixes it?", expect: ["index", "CREATE INDEX", "EXPLAIN"], minHits: 1 },
  { id: 59, cat: "db", q: "What is the danger of a long-running transaction in PostgreSQL?", expect: ["locks", "bloat", "vacuum", "blocking", "dead tuples"], minHits: 2 },
  { id: 60, cat: "db", q: "Redis memory is full. What two eviction-related settings matter?", expect: ["maxmemory", "maxmemory-policy", "eviction", "lru", "allkeys"], minHits: 2 },
  { id: 61, cat: "db", q: "How do you see slow queries in MySQL?", expect: ["slow_query_log", "slow query", "long_query_time", "EXPLAIN"], minHits: 1 },
  { id: 62, cat: "db", q: "What is replication lag and how does it cause read-after-write bugs?", expect: ["replica", "lag", "stale", "primary", "behind", "read"], minHits: 2 },
  { id: 63, cat: "db", q: "How do you check for table locks blocking queries in Postgres?", expect: ["pg_locks", "pg_stat_activity", "blocked", "blocking", "lock"], minHits: 1 },
  { id: 64, cat: "db", q: "Why can a deadlock occur and how do databases resolve it?", expect: ["circular", "lock", "abort", "rollback", "victim", "two transactions"], minHits: 2 },

  // ── Observability (65-74) ──
  { id: 65, cat: "observability", q: "What is the difference between metrics, logs, and traces?", expect: ["aggregate", "events", "request", "span", "distributed", "time series"], minHits: 2 },
  { id: 66, cat: "observability", q: "A Datadog monitor is flapping. How do you reduce noise?", expect: ["threshold", "evaluation window", "for", "recovery", "hysteresis", "no data"], minHits: 1 },
  { id: 67, cat: "observability", q: "What is cardinality and why does high cardinality hurt metrics systems?", expect: ["unique", "label", "tag", "series", "memory", "explosion"], minHits: 2 },
  { id: 68, cat: "observability", q: "What does a rising rate of HTTP 5xx tell you vs 4xx?", expect: ["server", "client", "5xx", "4xx", "your fault", "bad request"], minHits: 2 },
  { id: 69, cat: "observability", q: "How do you find which service in a trace is the bottleneck?", expect: ["span", "duration", "latency", "longest", "critical path", "waterfall"], minHits: 1 },
  { id: 70, cat: "observability", q: "What is a good alerting principle to avoid alert fatigue?", expect: ["symptom", "actionable", "page", "SLO", "user-facing", "not cause"], minHits: 1 },
  { id: 71, cat: "observability", q: "Logs show errors but no metric moved. What might be wrong with the metric?", expect: ["not instrumented", "sampling", "label", "cardinality", "not emitted", "missing"], minHits: 1 },
  { id: 72, cat: "observability", q: "What is the RED method for monitoring services?", expect: ["rate", "errors", "duration"], minHits: 2 },
  { id: 73, cat: "observability", q: "Why prefer histograms over averages for latency?", expect: ["percentile", "p99", "distribution", "tail", "average hides", "outlier"], minHits: 2 },
  { id: 74, cat: "observability", q: "How do you correlate a spike across metrics, logs and traces?", expect: ["timestamp", "trace id", "correlation", "time range", "request id"], minHits: 1 },

  // ── CI/CD & deploys (75-83) ──
  { id: 75, cat: "cicd", q: "A canary deploy shows elevated errors. What should happen automatically?", expect: ["rollback", "halt", "abort", "stop", "revert"], minHits: 1 },
  { id: 76, cat: "cicd", q: "What is a blue-green deployment?", expect: ["two environments", "switch", "traffic", "blue", "green", "instant rollback"], minHits: 2 },
  { id: 77, cat: "cicd", q: "Why use a canary release instead of deploying to 100% at once?", expect: ["small", "subset", "limit blast", "gradual", "detect", "percentage"], minHits: 2 },
  { id: 78, cat: "cicd", q: "A pipeline passes locally but fails in CI. What are common causes?", expect: ["environment", "dependency", "cache", "version", "env var", "state"], minHits: 2 },
  { id: 79, cat: "cicd", q: "What makes a deploy safely rollback-able?", expect: ["backward compatible", "migration", "feature flag", "versioned", "stateless"], minHits: 1 },
  { id: 80, cat: "cicd", q: "Why are database migrations risky during rolling deploys?", expect: ["backward", "compatible", "old code", "schema", "both versions", "expand contract"], minHits: 2 },
  { id: 81, cat: "cicd", q: "What is a feature flag used for in deployment safety?", expect: ["decouple", "toggle", "off", "gradual", "kill switch", "without deploy"], minHits: 1 },
  { id: 82, cat: "cicd", q: "How do you make a deploy idempotent?", expect: ["same result", "repeat", "no side effect", "declarative", "retry safe"], minHits: 1 },
  { id: 83, cat: "cicd", q: "What is the expand-contract (parallel change) migration pattern?", expect: ["add", "migrate", "remove", "backward compatible", "two phases", "expand", "contract"], minHits: 2 },

  // ── Cloud/IaC (84-91) ──
  { id: 84, cat: "cloud", q: "What does terraform plan do versus terraform apply?", expect: ["preview", "changes", "dry run", "apply", "execute", "no changes"], minHits: 2 },
  { id: 85, cat: "cloud", q: "Why is terraform state sensitive and how do you protect it?", expect: ["secrets", "remote", "backend", "lock", "encrypt", "S3"], minHits: 2 },
  { id: 86, cat: "cloud", q: "An autoscaling group isn't scaling up under load. What do you check?", expect: ["metric", "threshold", "cooldown", "max", "policy", "alarm"], minHits: 2 },
  { id: 87, cat: "cloud", q: "What is the principle of least privilege in IAM?", expect: ["minimum", "permissions", "only", "needed", "scope", "deny by default"], minHits: 2 },
  { id: 88, cat: "cloud", q: "How do you debug an S3 access denied error?", expect: ["IAM", "policy", "bucket policy", "permissions", "ACL", "principal"], minHits: 2 },
  { id: 89, cat: "cloud", q: "What causes a 'connection reset' from an AWS load balancer under low traffic?", expect: ["idle timeout", "keep-alive", "health", "deregister", "timeout"], minHits: 1 },
  { id: 90, cat: "cloud", q: "Why avoid hardcoding cloud credentials in code?", expect: ["leak", "secret", "rotate", "environment", "IAM role", "exposed"], minHits: 2 },
  { id: 91, cat: "cloud", q: "What is the benefit of immutable infrastructure?", expect: ["replace", "no drift", "reproducible", "rebuild", "consistent", "no in-place"], minHits: 2 },

  // ── Security (92-96) ──
  { id: 92, cat: "security", q: "How do you find hardcoded secrets in a codebase?", expect: ["grep", "trufflehog", "git-secrets", "regex", "scan", "password"], minHits: 1 },
  { id: 93, cat: "security", q: "What is SQL injection and the primary defense?", expect: ["parameterized", "prepared", "input", "query", "escape", "bind"], minHits: 2 },
  { id: 94, cat: "security", q: "A secret was committed to git. What must you do?", expect: ["rotate", "revoke", "invalidate", "remove", "history", "new"], minHits: 2 },
  { id: 95, cat: "security", q: "Why is it bad to log auth tokens or passwords?", expect: ["leak", "exposure", "retention", "access", "plaintext", "compromise"], minHits: 2 },
  { id: 96, cat: "security", q: "What is the difference between authentication and authorization?", expect: ["who you are", "what you can", "identity", "permission", "authn", "authz"], minHits: 2 },

  // ── Tricky / anti-hallucination (97-100) ──
  { id: 97, cat: "tricky", q: "If you don't know which namespace a failing pod is in, what do you do?", expect: ["--all-namespaces", "-A", "get pods", "list", "find"], minHits: 1, avoid: ["delete --all"] },
  { id: 98, cat: "tricky", q: "Should you run 'kubectl delete pod --all' to fix a CrashLoopBackOff? Explain.", expect: ["no", "don't", "logs", "root cause", "describe", "investigate"], minHits: 1, avoid: [] },
  { id: 99, cat: "tricky", q: "A junior wants to run 'rm -rf /var/log' to free disk. What's the risk and a safer option?", expect: ["truncate", "logrotate", "active", "still writing", "don't", "rotate"], minHits: 1 },
  { id: 100, cat: "tricky", q: "An alert fires at 3am with no runbook and you can't reproduce it. What's the right action?", expect: ["escalate", "document", "gather", "evidence", "ask", "don't guess"], minHits: 1 },
];
