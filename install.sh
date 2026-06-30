#!/usr/bin/env bash
# LocalSRE installer — downloads the latest VSIX from GitHub and installs it into VS Code.
# Usage:  bash install.sh
set -euo pipefail

REPO="narayana006/localsre"
VSIX="localsre.vsix"                 # single, always-latest file in the repo
URL="https://github.com/${REPO}/raw/main/${VSIX}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> LocalSRE installer (latest)"

# 1. Find the VS Code CLI (`code`). Fall back to the app bundle path on macOS.
CODE_BIN=""
if command -v code >/dev/null 2>&1; then
  CODE_BIN="code"
elif [ -x "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ]; then
  CODE_BIN="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
elif command -v code-insiders >/dev/null 2>&1; then
  CODE_BIN="code-insiders"
else
  echo "ERROR: VS Code 'code' command not found."
  echo "  Open VS Code → Cmd+Shift+P → 'Shell Command: Install code command in PATH', then re-run."
  exit 1
fi
echo "    using: ${CODE_BIN}"

# 2. Download the VSIX.
echo "==> Downloading ${VSIX} ..."
if ! curl -fSL "$URL" -o "${TMP}/${VSIX}"; then
  echo "ERROR: download failed from ${URL}"
  echo "  Check the version exists, or your network can reach github.com."
  exit 1
fi
BYTES=$(wc -c < "${TMP}/${VSIX}")
echo "    downloaded ${BYTES} bytes"
if [ "$BYTES" -lt 10000 ]; then
  echo "ERROR: file too small — likely a 404 page, not a real VSIX."
  exit 1
fi

# 3. Install (force = upgrade in place).
echo "==> Installing into VS Code ..."
"$CODE_BIN" --install-extension "${TMP}/${VSIX}" --force

# 4. OPTIONAL: if a Gemini key was passed at runtime, write it to LOCAL settings.json.
#    Usage:  GEMINI_KEY=your-key bash install.sh
#    The key is read from the environment at runtime — it is NEVER stored in this
#    script or in git, so there is nothing to revert. It lands only in your local
#    VS Code settings.json (plaintext on this machine; less secure than the keychain
#    command 'LocalSRE: Set Gemini API Key', but auto-configured).
if [ -n "${GEMINI_KEY:-}" ]; then
  echo "==> Configuring Gemini key in local settings.json ..."
  SETTINGS="${HOME}/Library/Application Support/Code/User/settings.json"
  python3 - "$SETTINGS" "$GEMINI_KEY" <<'PY'
import json, os, sys
path, key = sys.argv[1], sys.argv[2]
try:
    d = json.load(open(path)) if os.path.exists(path) and os.path.getsize(path) > 0 else {}
except Exception:
    d = {}
d["localsre.geminiApiKey"] = key
d["localsre.provider"] = "gemini"
d.setdefault("localsre.geminiModel", "gemini-flash-latest")
os.makedirs(os.path.dirname(path), exist_ok=True)
json.dump(d, open(path, "w"), indent=2)
print("    set localsre.geminiApiKey + provider=gemini in", path)
PY
fi

echo ""
echo "==> Done. Reload VS Code (Cmd+Shift+P → 'Developer: Reload Window') to activate LocalSRE."
[ -n "${GEMINI_KEY:-}" ] && echo "    Gemini is configured — reload and it'll use gemini-flash-latest."
