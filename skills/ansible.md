---
name: ansible
description: Run Ansible playbooks and ad-hoc commands — inventory, roles, vault, idempotent provisioning with --check/--diff.
---
# Ansible

Use `run_command`. Idempotent by design — re-running should converge, not duplicate.

## Run
- Ad-hoc: `ansible <host-pattern> -i inventory -m <module> -a "<args>"` (e.g. `-m ping`, `-m shell -a "uptime"`)
- Playbook: `ansible-playbook -i inventory site.yml` — add `--check` (dry-run), `--diff` (show changes), `-l <host>` (limit), `--tags <t>`, `-vvv` (verbose).

## Inventory / vars
- Static inventory file or dynamic plugins (gcp/aws). `group_vars/`, `host_vars/`.
- Vault (secrets): `ansible-vault create|edit|view <file>`; run with `--ask-vault-pass` or `--vault-password-file`.

## Safety
- ALWAYS `--check --diff` first against prod before a real run.
- Confirm targets: `ansible-inventory --list` / `ansible <pattern> --list-hosts`.
- Lint/syntax: `ansible-lint playbook.yml`; `ansible-playbook --syntax-check site.yml`.

Confirm the target hosts/inventory before any mutating run.
