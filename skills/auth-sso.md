---
name: auth-sso
description: Authenticate to internal apps/APIs behind Federated SSO (PingID/PingFederate) — capture session tokens/cookies from a UI login and reuse them as cookies for backend API calls. Trigger words: sso, pingid, ping federate, fedsso, saml, oidc, session cookie, 401/403 on internal API, "authenticate to", "pass cookies".
---
# FedSSO / PingID auth → cookie reuse for API calls

Goal: when an app sits behind Federated SSO (PingID/PingFederate), a user logs in via the browser UI and the server sets **session cookies**. Backend/API calls must replay those cookies (or a bearer token) or they get a 302→login or 401/403. This skill captures the post-SSO session and reuses it.

## How the flow works (SAML/OIDC via PingFederate)
1. Browser hits the app → app redirects to PingFederate (the IdP) for SSO.
2. After PingID MFA, the IdP posts a SAML assertion / OIDC code back to the app's ACS/callback.
3. The app sets a **session cookie** (common names: `JSESSIONID`, `PF`, `PA.<app>`, `<app>-session`, `access_token`/`id_token` cookies). THIS cookie is what authenticates subsequent API calls.
4. API calls succeed only if they send that cookie (or `Authorization: Bearer <token>` if the app exposes one).

## Capturing the session (pick what the environment allows)
- **From the browser (most reliable):** after the user logs into the UI, open DevTools → Application → Cookies → copy the session cookie(s) for the app domain. Or Network tab → copy any authed XHR "as cURL" (it includes the `Cookie:` header).
- **Programmatic login (if non-interactive creds allowed):** use a cookie jar that follows redirects through the IdP:
  ```bash
  curl -c jar.txt -b jar.txt -L \
    -d "pf.username=$SSO_USER&pf.pass=$SSO_PASS" \
    https://<app>/sso/login            # exact endpoint/params are PingFederate-config-specific
  # then reuse the jar:
  curl -b jar.txt https://<app>/api/v1/resource
  ```
  Note: PingID MFA usually blocks fully-headless login — interactive/browser capture is the realistic path. Service accounts often use OIDC client-credentials instead (no MFA): `curl -d 'grant_type=client_credentials&client_id=..&client_secret=..' https://<idp>/as/token.oauth2` → use the returned bearer.

## Reusing the session for backend API calls
- **As a cookie header:** `curl -H "Cookie: JSESSIONID=...; PF=..." https://<app>/api/...`
- **In Python:** `requests.Session()` with `s.cookies.set('JSESSIONID', '...', domain='<app>')`, or `s.get(url, cookies={...}, headers={'Cookie': '...'})`. Use one Session so cookies persist across calls.
- **Bearer instead of cookie (if available):** `-H "Authorization: Bearer <token>"`.
- Match the app's expectations: send the SAME cookie names/domain/path; include CSRF/XSRF header if the API requires it (often `X-XSRF-TOKEN` echoing an `XSRF-TOKEN` cookie).

## Gotchas / troubleshooting
- 302 to the IdP login on an API call = your session cookie is missing/expired → re-capture.
- Cookies are **domain- and path-scoped** — sending an app cookie to the wrong host fails. Check `Domain`/`Secure`/`HttpOnly`/`SameSite`.
- Sessions **expire** (idle + absolute timeout) — re-capture when calls start 401ing; don't loop retrying the same dead cookie.
- NEVER print full tokens/cookies into logs or commit them; treat them like passwords. Store transient session values in `.localsre/secrets` (gitignored) or env, not in code.

## What to ask the user when specifics are unknown
The exact cookie name(s), the app + IdP hostnames, whether a service-account/OIDC client-credentials path exists, and any required CSRF header. Save the confirmed answers with `remember` so future sessions don't re-ask.
