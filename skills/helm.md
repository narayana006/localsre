---
name: helm
description: Deploy and manage Kubernetes apps with Helm — install, upgrade, rollback, repos, templating, values.
---
# Helm

Use `run_command`. Confirm the kube context first (see the **kubernetes** skill): `kubectl config current-context`.

## Repos & charts
- `helm repo add <name> <url> && helm repo update`
- Search: `helm search repo <term>`; show values: `helm show values <chart>`

## Install / upgrade
- Install: `helm install <release> <chart> -n <ns> --create-namespace -f values.yaml`
- Upgrade (idempotent): `helm upgrade --install <release> <chart> -n <ns> -f values.yaml --set key=value`
- Dry run / render: `helm upgrade --install <release> <chart> --dry-run=server --debug` (server-side catches admission/validation errors; plain `--dry-run` only renders client-side) or `helm template <release> <chart> -f values.yaml`
- ⚠️ `helm upgrade` resets values NOT in your `-f`/`--set` back to chart defaults — pass a COMPLETE values file or use `--reuse-values` to avoid silently dropping prod config.

## Inspect & roll back
- `helm list -n <ns>`; `helm status <release> -n <ns>`
- History: `helm history <release> -n <ns>`
- Roll back: `helm rollback <release> <revision> -n <ns>`
- Values in use: `helm get values <release> -n <ns>`

## Troubleshooting
- Failed release stuck `pending-upgrade` → `helm rollback` to the last good revision.
- Always `--dry-run`/`template` to preview rendered manifests before applying to prod.
- After install/upgrade, verify pods with the **kubernetes** skill (`kubectl get pods -n <ns>`, check rollout status).

Never `helm uninstall` a release without explicit confirmation.
