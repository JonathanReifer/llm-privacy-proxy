#!/usr/bin/env bash
# One-time setup for llm-privacy-proxy.
# Generates HMAC + vault keys and appends them to ~/.bashrc (if not already set).
# Safe to run multiple times — skips keys that are already present.

set -euo pipefail

BASHRC="$HOME/.bashrc"

append_key() {
  local var="$1"
  local val="$2"
  if grep -q "^export ${var}=" "$BASHRC" 2>/dev/null; then
    echo "  ✓ ${var} already set in ${BASHRC} — skipping"
  else
    echo "" >> "$BASHRC"
    echo "export ${var}=\"${val}\"" >> "$BASHRC"
    echo "  + ${var} added to ${BASHRC}"
  fi
}

echo "=== llm-privacy-proxy setup ==="
echo ""
echo "Generating keys..."

HMAC_KEY="$(openssl rand -base64 32)"
VAULT_KEY="$(openssl rand -base64 32)"

append_key "LLM_PRIVACY_HMAC_KEY" "$HMAC_KEY"
append_key "LLM_PRIVACY_VAULT_KEY" "$VAULT_KEY"

echo ""
echo "Installing dependencies..."
cd "$(dirname "$0")"
bun install

echo ""
echo "=== Setup complete ==="
echo ""
echo "IMPORTANT: Run the following to load the keys into your current shell:"
echo ""
echo "  source ~/.bashrc"
echo ""
echo "Then start the proxy with:"
echo ""
echo "  bun start"
echo ""
echo "Verify it's running:"
echo ""
echo "  curl http://localhost:4444/health"
