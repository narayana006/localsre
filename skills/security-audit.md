---
name: security-audit
description: Security audit checklist — scan for hardcoded credentials, injection vulnerabilities, over-permissive IAM, exposed endpoints, insecure defaults, missing auth. Every finding must have a file:line reference. Trigger words: security, vulnerability, CVE, audit, secret, credential, IAM, permission, exploit, injection, exposure, sensitive.
---
# Security audit playbook

Goal: surface real, exploitable issues with exact evidence. No theoretical findings without a file:line. No false alarms that waste the developer's time.

## Before you start

State the scope:
- Which directories / services are in scope?
- Is this a full audit or targeted (e.g., "just the auth module")?
- What's the deployment target? (public internet vs internal, cloud vs on-prem)

Do NOT start grepping randomly. Work through the checklist in order.

## Category 1 — Hardcoded credentials and secrets

Run these searches, then read each hit:
```
search_code "password\s*=\s*['\"]"
search_code "api_key\s*=\s*['\"]"
search_code "secret\s*=\s*['\"]"
search_code "token\s*=\s*['\"]"
search_code "BEGIN RSA PRIVATE KEY"
search_code "AKIA"          # AWS access key prefix
search_code "ghp_\|github_pat"   # GitHub PATs
```

For each hit:
- Is the value a real secret or a placeholder like `"your-api-key-here"`? Only flag real-looking values.
- Is this file committed to git? `git log --all --oneline -- <file>` — if it has commits, the secret is in git history.

Finding format:
  `config/database.py:14` — hardcoded DB password `"Sup3rS3cr3t!"`. Visible in git history. Fix: load from env `os.environ["DB_PASSWORD"]` and add `config/database.py` to `.gitignore`.

## Category 2 — Injection vulnerabilities

### Shell injection
```
search_code "os.system\|subprocess.call\|subprocess.run\|exec("
search_code "child_process\|execSync\|spawnSync"
```
For each hit: does user-controlled input flow into the command string? Read the function and trace the argument back to its source.

Finding: `scripts/deploy.js:33` — `execSync('git clone ' + req.body.repoUrl)` — `repoUrl` is user-supplied and unsanitized. Attacker can inject `; rm -rf /`. Fix: use `execFile('git', ['clone', repoUrl])` with a validated allowlist for `repoUrl`.

### SQL injection
```
search_code "execute(\|query(\|raw_query\|f\"SELECT\|f'SELECT"
search_code "\+ \" WHERE\|\+ ' WHERE"
```
Flag string concatenation into SQL. Parameterized queries are safe; string building is not.

### Template injection / eval
```
search_code "eval(\|Function(\|new Function"
search_code "render_template_string\|from_string\|jinja2.Template("
```
Flag any `eval` of user input or template rendering of user-supplied strings.

## Category 3 — Authentication and authorization

- Find all HTTP route/endpoint definitions:
  ```
  search_code "@app.route\|router.get\|router.post\|router.put\|router.delete\|app.use("
  ```
  For each endpoint: is there an auth middleware/decorator applied? Flag any endpoint that handles sensitive data or mutations without auth.

- Check for authentication bypass patterns:
  ```
  search_code "skip_auth\|no_auth\|auth.*False\|verify.*False\|verify_ssl.*False"
  ```

- JWT / session token checks:
  ```
  search_code "jwt.decode\|verify_token\|decode_token"
  ```
  Is `options={"verify_signature": False}` or equivalent present anywhere? That disables JWT verification entirely.

- Check default credentials in setup/init files:
  ```
  search_code "admin.*admin\|root.*root\|admin.*password\|default.*password"
  ```

## Category 4 — Sensitive data exposure

- Logging of secrets or PII:
  ```
  search_code "log.*password\|logger.*token\|print.*secret\|console.log.*password"
  ```

- Error responses leaking stack traces or internal paths to clients:
  ```
  search_code "traceback.print_exc\|res.send(err\|res.json(err\|console.error(err"
  ```
  Stack traces in API responses expose internal structure to attackers.

- Sensitive data in URLs (appears in server logs):
  ```
  search_code "GET.*password\|GET.*token\|GET.*secret"
  ```

## Category 5 — Infrastructure and configuration

- Overly permissive IAM (if Terraform/YAML in scope):
  ```
  search_code '"*"\|Effect.*Allow.*Action.*\*\|roles/owner\|roles/editor'
  ```
  Flag `"Action": "*"` or `"Resource": "*"` combinations. Flag `roles/owner` granted to service accounts.

- Exposed ports / services:
  ```
  search_code "0\.0\.0\.0\|EXPOSE\|host.*0\.0\.0\.0"
  ```
  Any service binding to `0.0.0.0` in a production config should be flagged unless explicitly required.

- CORS misconfiguration:
  ```
  search_code "Access-Control-Allow-Origin.*\*\|cors.*origin.*\*\|allow_origins.*\*"
  ```
  Wildcard CORS on an authenticated API is dangerous.

- TLS/SSL disabled:
  ```
  search_code "verify=False\|rejectUnauthorized.*false\|InsecureRequestWarning\|SKIP_TLS"
  ```

## Category 6 — Dependency vulnerabilities

Run:
```
run_command pip audit            # Python
run_command npm audit            # Node
run_command bundle audit         # Ruby
run_command trivy fs .           # polyglot (if trivy is installed)
```

Report: package name, CVE ID, severity, fixed version. Do NOT list every low-severity CVE — focus on High/Critical.

## Writing the report

```
## Security Audit — <scope>

### CRITICAL (exploit immediately, must fix)
- [ ] `file:line` — <what> → <why exploitable> → Fix: <specific remediation>

### HIGH (significant risk, fix before next release)
- [ ] `file:line` — ...

### MEDIUM (defense in depth, schedule for fix)
- [ ] `file:line` — ...

### LOW / INFORMATIONAL (good to fix, not blocking)
- `file:line` — ...

### Verified Safe (explicitly checked and OK)
- JWT signature verification: enabled in `auth/tokens.py:22` ✓
- DB queries: all use parameterized queries in `db/queries.py` ✓
```

## Hard rules

- Never flag a finding without a specific file:line. "There might be SQL injection somewhere" is not a finding.
- Verify a value looks like a real secret before flagging it — placeholder strings waste developer time.
- Distinguish "exploitable now" from "defense in depth". A wildcard CORS on an internal-only API is lower risk than one on a public API.
- Do NOT fix security issues without confirmation — understand the full blast radius first.
- If credentials appear to be in git history: flag as CRITICAL even if the file is now fixed, because the history is still public.
