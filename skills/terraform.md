---
name: terraform
description: Manage infrastructure as code with Terraform — init, plan, apply, state, workspaces, fmt/validate.
---
# Terraform

Use `run_command`. SAFETY: `apply` and `destroy` change real infrastructure — always run `plan` first, show the plan, and get approval before applying. Never `destroy` without explicit confirmation.

## Core loop
- `terraform init` (after provider/module changes)
- `terraform fmt -recursive` and `terraform validate`
- `terraform plan -out=tfplan` → review the diff
- `terraform apply tfplan` (apply the reviewed plan exactly)

## State
- `terraform state list`; `terraform state show <addr>`
- Move/rename: `terraform state mv <src> <dst>`; remove: `terraform state rm <addr>`
- Import existing: `terraform import <addr> <id>`

## Workspaces / targeting
- `terraform workspace list|select|new <name>`
- Scope a change: `terraform plan -target=<addr>` (use sparingly)
- Vars: `-var 'k=v'` or `-var-file=env.tfvars`

## Troubleshooting
- Drift: `terraform plan` shows unexpected changes → investigate before applying.
- Lock stuck: `terraform force-unlock <lock-id>` (only if you're sure no apply is running).
- Provider/auth errors (GCP): ensure ADC or the SA creds are set (see the **gcp** skill).

Workflow: change .tf → fmt/validate → plan → SHOW the plan + summarize the blast radius → on approval, apply → verify with `state show` or the cloud CLI.
