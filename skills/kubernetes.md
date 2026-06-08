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
- `kubectl logs <pod> -n <ns> [-c <container>] [--tail=200] [--previous]`
- `kubectl top pods -n <ns>` (needs metrics-server)
- `kubectl get events -n <ns> --sort-by=.lastTimestamp`

## Operate (mutating)
- Restart: `kubectl rollout restart deploy/<name> -n <ns>`
- Scale: `kubectl scale deploy/<name> --replicas=<N> -n <ns>`
- Roll back: `kubectl rollout undo deploy/<name> -n <ns>`
- Check rollout: `kubectl rollout status deploy/<name> -n <ns>`

NEVER run destructive commands (`delete namespace`, `delete pvc`, etc.) unless explicitly asked. Prefer the least destructive action and verify with a follow-up `get`/`describe`.
