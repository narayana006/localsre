#!/usr/bin/env python3
"""
gha_adoption.py — measure GitHub Actions adoption across an org's repos.

Reads repo names (owner/repo) from a file OR directly from your BigQuery
inventory table, checks each via the GitHub API, and writes a CSV (and
optionally a BQ table) classifying migration status.

Tiers per repo:
  configured_workflows : # of workflow files (.github/workflows)
  total_runs           : workflow runs ever
  recent_runs          : runs in the last --days (the real "active" signal)
  jenkins              : Jenkinsfile still present on default branch
  status               : migrated | in-progress | configured-idle | jenkins-only | none | inaccessible

Auth: uses your existing `gh` login token (incl. GitHub Enterprise host).
      Or set GITHUB_TOKEN and --host github.yourco.com.

Usage:
  # from a file (one owner/repo per line, exported from BQ)
  python3 gha_adoption.py --repos repos.txt --out gha-adoption.csv

  # straight from BigQuery (needs: pip install google-cloud-bigquery)
  python3 gha_adoption.py --bq-query "SELECT repo FROM proj.ds.repo_inventory" --out gha-adoption.csv

  # tune
  python3 gha_adoption.py --repos repos.txt --days 90 --workers 12
"""
import argparse, csv, os, subprocess, sys, time, datetime, threading
from concurrent.futures import ThreadPoolExecutor, as_completed
import urllib.request, urllib.error, json

def gh_token():
    if os.environ.get("GITHUB_TOKEN"):
        return os.environ["GITHUB_TOKEN"]
    try:
        return subprocess.check_output(["gh", "auth", "token"], text=True).strip()
    except Exception:
        sys.exit("No token: set GITHUB_TOKEN or run `gh auth login`.")

class GH:
    def __init__(self, host, token):
        self.base = "https://api.github.com" if host == "github.com" else f"https://{host}/api/v3"
        self.token = token
        self.lock = threading.Lock()

    def get(self, path, params=None):
        url = self.base + path
        if params:
            url += "?" + "&".join(f"{k}={v}" for k, v in params.items())
        req = urllib.request.Request(url, headers={
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        })
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    remaining = r.headers.get("X-RateLimit-Remaining")
                    if remaining is not None and int(remaining) < 50:
                        reset = int(r.headers.get("X-RateLimit-Reset", "0"))
                        wait = max(0, reset - int(time.time())) + 2
                        if wait > 0:
                            print(f"  [rate-limit] sleeping {wait}s", file=sys.stderr)
                            time.sleep(wait)
                    return r.status, json.loads(r.read().decode() or "{}")
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    return 404, {}
                if e.code in (403, 429):  # secondary rate limit / abuse
                    time.sleep(5 * (attempt + 1)); continue
                return e.code, {}
            except Exception:
                time.sleep(2 * (attempt + 1))
        return 0, {}

def classify(repo, gh, cutoff):
    st, wf = gh.get(f"/repos/{repo}/actions/workflows")
    if st in (404, 0) or "total_count" not in wf:
        return [repo, "NA", "NA", "NA", "NA", "inaccessible"]
    configured = wf.get("total_count", 0)
    total_runs = ""  # skipped by default (saves 1 call/repo → 1500 repos fit one rate-limit window)
    _, rec = gh.get(f"/repos/{repo}/actions/runs", {"per_page": "1", "created": f">={cutoff}"})
    recent_runs = rec.get("total_count", 0)
    jst, _ = gh.get(f"/repos/{repo}/contents/Jenkinsfile")
    jenkins = "yes" if jst == 200 else "no"
    if recent_runs > 0 and jenkins == "no":   status = "migrated"
    elif recent_runs > 0 and jenkins == "yes": status = "in-progress"
    elif configured > 0 and recent_runs == 0:  status = "configured-idle"
    elif jenkins == "yes":                      status = "jenkins-only"
    else:                                       status = "none"
    return [repo, configured, total_runs, recent_runs, jenkins, status]

def load_repos(args):
    if args.bq_query:
        from google.cloud import bigquery
        client = bigquery.Client()
        return [dict(row).get("repo") or list(dict(row).values())[0] for row in client.query(args.bq_query).result()]
    with open(args.repos) as f:
        return [l.strip() for l in f if l.strip()]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repos", help="file with owner/repo per line")
    ap.add_argument("--bq-query", help="BigQuery SQL returning a 'repo' column (owner/repo)")
    ap.add_argument("--out", default="gha-adoption.csv")
    ap.add_argument("--host", default=os.environ.get("GH_HOST", "github.com"))
    ap.add_argument("--days", type=int, default=90)
    ap.add_argument("--workers", type=int, default=10)
    args = ap.parse_args()
    if not args.repos and not args.bq_query:
        ap.error("give --repos FILE or --bq-query SQL")

    repos = load_repos(args)
    cutoff = (datetime.date.today() - datetime.timedelta(days=args.days)).isoformat()
    gh = GH(args.host, gh_token())
    print(f"Checking {len(repos)} repos | host {args.host} | active since {cutoff} | workers {args.workers}")

    rows, done = [], 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(classify, r, gh, cutoff): r for r in repos}
        for fut in as_completed(futs):
            rows.append(fut.result())
            done += 1
            if done % 50 == 0:
                print(f"  {done}/{len(repos)}", file=sys.stderr)

    with open(args.out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["repo", "configured_workflows", "total_runs", "recent_runs", "jenkins", "status"])
        w.writerows(sorted(rows))

    summary = {}
    for r in rows:
        summary[r[5]] = summary.get(r[5], 0) + 1
    print(f"\n=== SUMMARY ({len(rows)} repos) ===")
    for k, v in sorted(summary.items(), key=lambda x: -x[1]):
        print(f"  {k:<18} {v}")
    print(f"\nFull results: {args.out}")

if __name__ == "__main__":
    main()
