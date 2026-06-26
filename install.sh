#!/usr/bin/env bash
# LocalSRE installer — downloads the latest VSIX from GitHub and installs it into VS Code.
# Usage:  bash install.sh            (installs the pinned latest version)
#         bash install.sh 0.21.2     (installs a specific version)
set -euo pipefail

VERSION="${1:-0.22.0}"
REPO="narayana006/localsre"
VSIX="localsre-${VERSION}.vsix"
URL="https://github.com/${REPO}/raw/main/${VSIX}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> LocalSRE installer"
echo "    version: ${VERSION}"

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

echo ""
echo "==> Done. Reload VS Code (Cmd+Shift+P → 'Developer: Reload Window') to activate LocalSRE ${VERSION}."
