#!/usr/bin/env bash
# gha-adoption.sh — measure GitHub Actions adoption across an org's repos.
#
# Input:  repos.txt — one "owner/repo" per line (export from your BigQuery inventory).
# Output: gha-adoption.csv — repo,configured,total_runs,recent_runs,jenkins,status
#
# Usage:  bash gha-adoption.sh repos.txt
#         RECENT_DAYS=90 PAR=10 bash gha-adoption.sh repos.txt
#
# Auth:   run where `gh` is logged in to the org's GitHub (e.g. the office machine).
#         For GitHub Enterprise: gh auth login --hostname github.yourco.com  (gh api auto-uses it)
set -euo pipefail

LIST="${1:-repos.txt}"
PAR="${PAR:-10}"                 # parallel workers (stay modest for rate limits)
RECENT_DAYS="${RECENT_DAYS:-90}" # "active" = a run in the last N days
OUT="gha-adoption.csv"

[ -f "$LIST" ] || { echo "ERROR: $LIST not found. Export 'owner/repo' per line from BQ."; exit 1; }
command -v gh >/dev/null || { echo "ERROR: gh CLI not installed."; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "ERROR: gh not authenticated. Run: gh auth login"; exit 1; }

# cutoff date (macOS + Linux compatible)
CUTOFF="$(date -u -v-${RECENT_DAYS}d +%Y-%m-%d 2>/dev/null || date -u -d "-${RECENT_DAYS} days" +%Y-%m-%d)"
echo "Checking $(wc -l < "$LIST" | tr -d ' ') repos | recent window: since $CUTOFF | parallelism: $PAR"
echo "repo,configured_workflows,total_runs,recent_runs,jenkins,status" > "$OUT"

check_one() {
  local repo="$1" cutoff="$2"
  repo="$(echo "$repo" | tr -d '\r' | xargs)"        # strip CR/whitespace
  [ -z "$repo" ] && return
  # 1) configured workflow files
  local wf; wf=$(gh api "repos/$repo/actions/workflows" --jq '.total_count' 2>/dev/null || echo "ERR")
  if [ "$wf" = "ERR" ]; then echo "$repo,NA,NA,NA,NA,inaccessible"; return; fi
  # 2) total runs ever
  local tot; tot=$(gh api "repos/$repo/actions/runs?per_page=1" --jq '.total_count' 2>/dev/null || echo 0)
  # 3) runs in the recent window (the real "active" signal)
  local rec; rec=$(gh api "repos/$repo/actions/runs?per_page=1&created=>=$cutoff" --jq '.total_count' 2>/dev/null || echo 0)
  # 4) still has a Jenkinsfile?
  local jk="no"
  gh api "repos/$repo/contents/Jenkinsfile" --jq '.name' >/dev/null 2>&1 && jk="yes"
  # classify
  local status
  if [ "${rec:-0}" -gt 0 ] && [ "$jk" = "no" ]; then status="migrated"
  elif [ "${rec:-0}" -gt 0 ] && [ "$jk" = "yes" ]; then status="in-progress"
  elif [ "${wf:-0}" -gt 0 ] && [ "${rec:-0}" -eq 0 ]; then status="configured-idle"
  elif [ "$jk" = "yes" ]; then status="jenkins-only"
  else status="none"; fi
  echo "$repo,$wf,$tot,$rec,$jk,$status"
}
export -f check_one

# fan out; append rows as they complete
cat "$LIST" | xargs -P "$PAR" -I {} bash -c 'check_one "$@"' _ {} "$CUTOFF" >> "$OUT"

echo ""
echo "=== SUMMARY ($(($(wc -l < "$OUT")-1)) repos) ==="
tail -n +2 "$OUT" | awk -F, '{c[$6]++} END {for (k in c) printf "  %-18s %d\n", k, c[k]}' | sort -k2 -rn
echo ""
echo "Full results: $OUT"
