---
name: kubernetes
description: Inspect and operate Kubernetes / GKE clusters with kubectl — pods, logs, deployments, scaling, rollouts.
---
# Kubernetes / kubectl

Use `run_command`. You have the FULL `kubectl` CLI — not just the commands below.
SAFETY: confirm the target before any change — `kubectl config current-context`.
Always start read-only; only mutate when the task clearly requires it (the user approves each command).

## Discover any command (use when something isn't listed here)
- `kubectl --help`, `kubectl <command> --help` (e.g. `kubectl rollout --help`)
- `kubectl api-resources` (every resource type), `kubectl explain <resource>` (fields)
- `kubectl get <any-resource> -A`, add `-o yaml`/`-o wide`/`-o json` for detail
- Contexts: `kubectl config get-contexts` / `use-context <name>`
Anything kubectl can do, you can do — look it up with `--help` rather than guessing syntax.

## Inspect (read-only, do these first)
- `kubectl get pods -A` / `kubectl get deploy,svc -n <ns>`
- `kubectl describe pod <pod> -n <ns>`
- Logs: `kubectl logs <pod> -n <ns> [-c <container>] [--tail=200] [--previous]`; follow with `-f`; across all replicas of a deployment `kubectl logs -l app=<x> -n <ns> --all-containers --tail=200`; recent window `--since=15m`. (Multi-pod live tail: `stern <app> -n <ns>` if installed.)
- `kubectl top pods -n <ns>` (needs metrics-server)
- `kubectl get events -n <ns> --sort-by=.lastTimestamp`
- Ingress: `kubectl get ingress -n <ns>`; `kubectl describe ingress <name> -n <ns>` — check rules/hosts, backend service+port, and TLS secret. 502/503 usually = backend has no ready endpoints: `kubectl get endpoints <svc> -n <ns>`. Also check the ingress-controller pod logs (e.g. `kubectl logs -n ingress-nginx -l app.kubernetes.io/name=ingress-nginx`).

## Operate (mutating)
- Restart: `kubectl rollout restart deploy/<name> -n <ns>`
- Scale: `kubectl scale deploy/<name> --replicas=<N> -n <ns>`
- Roll back: `kubectl rollout undo deploy/<name> -n <ns>`
- Check rollout: `kubectl rollout status deploy/<name> -n <ns>`

NEVER run destructive commands (`delete namespace`, `delete pvc`, etc.) unless explicitly asked. Prefer the least destructive action and verify with a follow-up `get`/`describe`.
