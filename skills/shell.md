---
name: shell
description: Expert Unix/Linux/macOS command line — search, text processing (grep/sed/awk/jq), processes, disk, network, archives, robust pipelines.
---
# Shell / command-line mastery

Run commands via run_command. Prefer precise, non-interactive commands; compose with pipes. Inspect before you mutate.

## Search & navigate
- Find files: `find . -name "*.py" -type f`; fast: `rg --files | rg <pat>`
- Search content: `grep -rn "pat" .` or `rg "pat"` (ripgrep — fast, respects .gitignore)
- Recent/large: `find . -mtime -1` ; `find . -size +100M`

## Text processing
- `grep -E` (regex), `-v` (invert), `-c` (count), `-A3 -B3` (context), `-l` (files only)
- `sed 's/old/new/g' f` (in place: macOS `sed -i ''`, Linux `sed -i`)
- `awk '{print $1,$3}'` ; `awk -F, '{s+=$2} END{print s}'`
- `cut -d: -f1` ; `sort | uniq -c | sort -rn` (frequencies) ; `tr` ; `head/tail -n` ; `wc -l`
- JSON: `jq '.items[].name'` ; YAML: `yq`

## Processes & system
- `ps aux | grep <n>` ; `pgrep -fl <n>` ; `kill -9 <pid>` ; `lsof -i :8080` (who's on a port)
- `top`/`htop` ; `df -h` (disk) ; `du -sh *` (sizes) ; `uptime` ; macOS mem `vm_stat`

## Network
- `curl -sSL <url>` ; `-I` (headers) ; `-X POST -d @body.json -H "Content-Type: application/json"`
- `dig <host>` ; `nc -vz <host> <port>` (port check) ; `ping -c3`

## Files & archives
- `tar czf out.tgz dir/` / `tar xzf out.tgz` ; `zip -r out.zip dir/` / `unzip`
- `chmod +x` ; `ln -s` ; `rsync -av src/ dst/` ; `find ... | xargs <cmd>` for batch

## Habits
- Quote variables/paths. In scripts use `set -euo pipefail`. Prefer `--dry-run` on destructive ops; look before `rm -rf`. Note macOS BSD vs GNU differences (`sed -i ''`, `stat -f`). Pipe big output through `head`/`grep` rather than dumping everything.
