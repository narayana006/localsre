---
name: argocd
description: Manage ArgoCD GitOps deployments — apps, sync, rollback, health, RBAC — via the argocd CLI or kubectl.
---
# ArgoCD

Auth: `argocd login <argocd-server> --username admin --password <pw>` or `--sso`. Get server address: `kubectl get svc argocd-server -n argocd`. Use `run_command`. Read-only first; confirm before sync/rollback.

Alternative — all ops via kubectl without the CLI:
`kubectl -n argocd get applications` / `kubectl -n argocd describe application <name>`

## App health (start here)
```bash
argocd app list                           # all apps — Health, Sync status
argocd app get <app-name>                 # detail: health, sync, resources, last sync time
argocd app resources <app-name>           # every K8s resource managed by this app
```

## Sync
```bash
# Trigger a sync (deploy latest from Git)
argocd app sync <app-name>

# Sync with options
argocd app sync <app-name> --prune          # delete resources removed from Git
argocd app sync <app-name> --dry-run        # show what would change (safe preview)
argocd app sync <app-name> --force          # replace resources (use cautiously)
argocd app sync <app-name> --resource apps/Deployment/<name>   # sync only one resource

# Wait for sync to complete
argocd app wait <app-name> --health --timeout 120
```

## Rollback
```bash
# List history (revision IDs)
argocd app history <app-name>

# Roll back to a previous revision
argocd app rollback <app-name> <revision-id>

# After rollback, re-enable auto-sync if needed
argocd app set <app-name> --sync-policy automated
```

## App config & diff
```bash
# Show the live manifest vs Git (what's drifted)
argocd app diff <app-name>

# Show current app spec (source repo, path, target revision, helm values)
argocd app get <app-name> -o yaml

# Update app settings (e.g. change target branch)
argocd app set <app-name> --revision main
argocd app set <app-name> --helm-set image.tag=v1.2.3
```

## Resource health details
```bash
# Health of specific resource
argocd app resources <app-name> --kind Deployment

# Logs for a pod via argocd
argocd app logs <app-name> --container <container>

# Describe a specific resource
argocd app resource-actions list <app-name> --kind Deployment --resource-name <deploy-name>
```

## App creation & deletion
```bash
# Create app (Git source)
argocd app create <app-name> \
  --repo https://github.com/org/repo.git \
  --path k8s/overlays/prod \
  --dest-server https://kubernetes.default.svc \
  --dest-namespace prod \
  --sync-policy automated --self-heal --prune

# Delete (removes ArgoCD app object — does NOT delete K8s resources unless --cascade)
argocd app delete <app-name>
argocd app delete <app-name> --cascade   # also deletes deployed resources — confirm with user
```

## Projects & RBAC
```bash
argocd proj list
argocd proj get <proj-name>              # allowed clusters, repos, resource whitelist/blacklist
argocd account list                      # users and their roles
argocd account get-user-info             # current user
```

## ArgoCD server health
```bash
kubectl get pods -n argocd               # argocd-server, repo-server, application-controller, redis, dex
kubectl logs -n argocd deployment/argocd-application-controller --tail=100
kubectl logs -n argocd deployment/argocd-repo-server --tail=100
argocd version                           # client + server versions
```

## Common issues
| Symptom | Check |
|---|---|
| App stuck OutOfSync | `argocd app diff` — resource drifted? Annotation/label mutation by operator? Add ignore diff if expected |
| Sync failed | `argocd app get <app>` → look at sync result message; check repo-server logs for Git/Helm errors |
| Health = Degraded | `argocd app resources <app>` → find unhealthy resource → `kubectl describe` it for events |
| Rollback didn't apply | Auto-sync enabled overrides rollback — disable: `argocd app set <app> --sync-policy none` first |
| Repo not accessible | `argocd repo list` + `argocd repo get <url>` — check credentials/SSH key in argocd-repo-server |
| Image not updating | Tag pinned in values? Check `argocd app get` → `targetRevision`; ensure image-updater is configured |

Pair with **kubernetes** for pod/deployment ops, **helm** for Helm-sourced apps, and **github-ops** for checking the Git source.
