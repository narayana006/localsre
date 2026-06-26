#!/usr/bin/env bash
# ollama-speed.sh — one-time Ollama tuning for LocalSRE on a Mac (office laptop).
# Makes qwen3-coder noticeably faster: never unloads, flash attention, compact KV
# cache, and a bounded 16K context (down from the model's 256K default).
#
# Run once:   bash ollama-speed.sh
# Safe to re-run. Does NOT touch any network/cloud — purely local Ollama config.
set -euo pipefail

FAST_MODEL="qwen3-coder:fast"
CTX="${OLLAMA_CTX:-16384}"           # 16K is plenty for SRE/coding; lower = faster prefill

echo "==> LocalSRE Ollama speed tuning"

if ! command -v ollama >/dev/null 2>&1; then
  echo "ERROR: 'ollama' not found. Install Ollama first (https://ollama.com)."; exit 1
fi

# Auto-detect the base model: use arg 1 if given, else first qwen*coder, else first model.
BASE_MODEL="${1:-}"
if [ -z "$BASE_MODEL" ]; then
  BASE_MODEL="$(ollama list 2>/dev/null | awk 'NR>1{print $1}' | grep -i 'qwen.*coder' | head -1 || true)"
  [ -z "$BASE_MODEL" ] && BASE_MODEL="$(ollama list 2>/dev/null | awk 'NR>1{print $1}' | head -1 || true)"
fi
if [ -z "$BASE_MODEL" ]; then
  echo "ERROR: no models found. Pull one first, e.g.: ollama pull qwen3-coder:30b"; exit 1
fi
echo "    base model: ${BASE_MODEL}   ->   ${FAST_MODEL}   (ctx ${CTX})"

# RAM advisory: a 30B model wants ~24GB+ free. On a low-RAM laptop a 14B is much faster.
RAM_GB="$(sysctl -n hw.memsize 2>/dev/null | awk '{printf "%d", $1/1024/1024/1024}')"
echo "    machine RAM: ${RAM_GB} GB"
if [ "${RAM_GB:-0}" -lt 32 ] && echo "$BASE_MODEL" | grep -qiE '30b|32b'; then
  echo "    NOTE: ${RAM_GB}GB RAM with a 30B model may spill to CPU (slow)."
  if ollama list 2>/dev/null | awk 'NR>1{print $1}' | grep -qi '14b'; then
    SMALLER="$(ollama list 2>/dev/null | awk 'NR>1{print $1}' | grep -i '14b' | head -1)"
    echo "    A faster option is installed: ${SMALLER}. Re-run as:  bash ollama-speed.sh ${SMALLER}"
  fi
fi

# 1) Persistent env so the menubar Ollama.app picks these up on every launch.
echo "==> Setting persistent Ollama env (launchctl)…"
launchctl setenv OLLAMA_KEEP_ALIVE -1        # never unload the model (kills cold-start)
launchctl setenv OLLAMA_FLASH_ATTENTION 1    # faster attention, less memory
launchctl setenv OLLAMA_KV_CACHE_TYPE q8_0   # compact KV cache → fits more on GPU
launchctl setenv OLLAMA_NUM_PARALLEL 1       # single-user: full context per request

# Also drop them in the shell profile for `ollama serve` started from a terminal.
PROFILE="${HOME}/.zshrc"
if ! grep -q "OLLAMA_KEEP_ALIVE" "$PROFILE" 2>/dev/null; then
  {
    echo ""
    echo "# LocalSRE Ollama speed (added by ollama-speed.sh)"
    echo "export OLLAMA_KEEP_ALIVE=-1"
    echo "export OLLAMA_FLASH_ATTENTION=1"
    echo "export OLLAMA_KV_CACHE_TYPE=q8_0"
    echo "export OLLAMA_NUM_PARALLEL=1"
  } >> "$PROFILE"
  echo "    appended exports to ${PROFILE}"
fi

# 2) Build the bounded-context fast variant.
echo "==> Creating ${FAST_MODEL} (num_ctx ${CTX})…"
TMP_MF="$(mktemp)"
cat > "$TMP_MF" <<EOF
FROM ${BASE_MODEL}
PARAMETER num_ctx ${CTX}
PARAMETER num_predict 2048
PARAMETER temperature 0.2
EOF
ollama create "${FAST_MODEL}" -f "$TMP_MF"
rm -f "$TMP_MF"

# 3) Restart the Ollama service so env vars take effect, then warm the model.
echo "==> Restarting Ollama…"
osascript -e 'quit app "Ollama"' >/dev/null 2>&1 || pkill -f "ollama serve" 2>/dev/null || true
sleep 2
if [ -d "/Applications/Ollama.app" ]; then open -a Ollama; else (OLLAMA_KEEP_ALIVE=-1 OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q8_0 nohup ollama serve >/dev/null 2>&1 &); fi
sleep 4

echo "==> Warming ${FAST_MODEL} (one-time load)…"
curl -s --max-time 120 http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"${FAST_MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":3,\"stream\":false}" >/dev/null || true

echo ""
echo "==> Loaded models (want: 100% GPU, UNTIL Forever):"
ollama ps || true
echo ""
echo "==> DONE."
echo "    Point LocalSRE at the fast model: VS Code Settings → localsre.model → ${FAST_MODEL}"
echo "    (or run:  defaults write / set \"localsre.model\": \"${FAST_MODEL}\" in settings.json)"
