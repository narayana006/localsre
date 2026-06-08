---
name: kubernetes
description: Inspect and operate Kubernetes / GKE clusters with kubectl — pods, logs, deployments, scaling, rollouts.
---
# Kubernetes / kubectl

Use `run_command`. SAFETY: confirm the target before any change — `kubectl config current-context`.
Always start read-only; only mutate when the task clearly requires it (the user approves each command).

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
