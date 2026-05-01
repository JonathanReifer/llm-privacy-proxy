#!/usr/bin/env bash
# One-time setup for llm-privacy-proxy.
# Generates HMAC + vault keys, installs dependencies, configures Claude Code.
# Safe to run multiple times — skips steps that are already complete.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")"; pwd)"
BASHRC="$HOME/.bashrc"
PROXY_PORT="${LLM_PROXY_PORT:-4444}"
PROXY_URL="http://localhost:${PROXY_PORT}"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"

# ── Helpers ────────────────────────────────────────────────────────────────

append_key() {
  local var="$1"
  local val="$2"
  if grep -q "^export ${var}=" "$BASHRC" 2>/dev/null; then
    echo "  ✓ ${var} already set — skipping"
  else
    printf '\nexport %s="%s"\n' "$var" "$val" >> "$BASHRC"
    echo "  + ${var} added to ${BASHRC}"
  fi
}

ask_yes() {
  # ask_yes "Question" [default: Y|N]  → exits 0 for yes, 1 for no
  local prompt="$1"
  local default="${2:-Y}"
  if [ ! -t 0 ]; then
    # non-interactive: use default
    [[ "$default" =~ ^[Yy] ]] && return 0 || return 1
  fi
  local hint="[Y/n]"
  [[ "$default" =~ ^[Nn] ]] && hint="[y/N]"
  read -rp "${prompt} ${hint} " answer
  answer="${answer:-$default}"
  [[ "$answer" =~ ^[Yy] ]]
}

# ── Step 1: Encryption keys ────────────────────────────────────────────────

echo "=== llm-privacy-proxy setup ==="
echo ""
echo "Generating keys..."

HMAC_KEY="$(openssl rand -base64 32)"
VAULT_KEY="$(openssl rand -base64 32)"

append_key "LLM_PRIVACY_HMAC_KEY" "$HMAC_KEY"
append_key "LLM_PRIVACY_VAULT_KEY" "$VAULT_KEY"

# ── Step 2: Install into ~/.claude (optional, default yes) ─────────────────

echo ""
INSTALL_PATH="$SCRIPT_DIR"

if ask_yes "Install proxy into ~/.claude/llm-privacy-proxy? (recommended — keeps it alongside Claude Code)"; then
  INSTALL_DEST="$HOME/.claude/llm-privacy-proxy"
  if [ -d "$INSTALL_DEST" ] && [ "$INSTALL_DEST" != "$SCRIPT_DIR" ]; then
    echo "  ↻ Updating existing install at ${INSTALL_DEST}"
  else
    echo "  + Installing to ${INSTALL_DEST}"
  fi
  mkdir -p "$INSTALL_DEST"
  # Copy runtime files only (no .git, tests, Plans)
  cp -r "$SCRIPT_DIR/src" "$INSTALL_DEST/"
  cp "$SCRIPT_DIR/package.json" "$INSTALL_DEST/"
  cp "$SCRIPT_DIR/tsconfig.json" "$INSTALL_DEST/" 2>/dev/null || true
  [ -f "$SCRIPT_DIR/bun.lock" ] && cp "$SCRIPT_DIR/bun.lock" "$INSTALL_DEST/"
  cp "$SCRIPT_DIR/proxy.sh" "$INSTALL_DEST/"
  cp "$SCRIPT_DIR/start-proxy.sh" "$INSTALL_DEST/"
  chmod +x "$INSTALL_DEST/proxy.sh" "$INSTALL_DEST/start-proxy.sh"
  echo "  + Installing dependencies..."
  (cd "$INSTALL_DEST" && bun install --silent)
  INSTALL_PATH="$INSTALL_DEST"
  echo "  ✓ Installed to ${INSTALL_DEST}"
else
  echo "  ✓ Using current directory: ${SCRIPT_DIR}"
  echo "  + Installing dependencies..."
  (cd "$SCRIPT_DIR" && bun install --silent)
fi

# ── Step 2b: Migrate existing file vault to SQLite (if present) ───────────

OLD_VAULT="$HOME/.llm-privacy/vault.enc.json"
if [ -f "$OLD_VAULT" ]; then
  echo ""
  echo "Old file vault detected — migrating to SQLite..."

  # Prefer key already in env; fall back to reading it from bashrc without sourcing
  if [ -z "${LLM_PRIVACY_VAULT_KEY:-}" ]; then
    LLM_PRIVACY_VAULT_KEY="$(grep '^export LLM_PRIVACY_VAULT_KEY=' "$BASHRC" 2>/dev/null \
      | tail -1 | sed 's/^export LLM_PRIVACY_VAULT_KEY="\(.*\)"$/\1/')"
  fi

  if [ -n "${LLM_PRIVACY_VAULT_KEY:-}" ]; then
    migrate_out="$(LLM_PRIVACY_VAULT_KEY="$LLM_PRIVACY_VAULT_KEY" bun --eval "
const { SqliteVault } = await import('${INSTALL_PATH}/src/vault.js');
const v = new SqliteVault();
await v.ready;
" 2>&1 || true)"

    if [ -f "${OLD_VAULT}.migrated" ]; then
      entries="$(echo "$migrate_out" | grep -oE '[0-9]+ vault entries' | head -1)"
      echo "  ✓ ${entries:-Vault entries} migrated → ~/.llm-privacy/vault.db"
      echo "  ✓ Old vault renamed to vault.enc.json.migrated (kept as backup)"
    else
      echo "  ! Migration did not complete — proxy will retry automatically on first start"
    fi
  else
    echo "  ! Vault key not available in current shell"
    echo "    Migration will run automatically on first proxy start after: source ~/.bashrc"
  fi
fi

# ── Step 3: Configure Claude Code settings.json ────────────────────────────

echo ""
echo "Configuring Claude Code..."

if [ ! -f "$CLAUDE_SETTINGS" ]; then
  # Claude Code not installed or settings not yet created
  echo "  ! ~/.claude/settings.json not found — skipping Claude Code integration"
  echo "    Run this script again after installing Claude Code, or add manually:"
  echo "    env.ANTHROPIC_BASE_URL = \"${PROXY_URL}\""
  echo "    SessionStart hook: ${INSTALL_PATH}/proxy.sh start"
else
  HOOK_CMD="${INSTALL_PATH}/proxy.sh start"

  python3 - "$CLAUDE_SETTINGS" "$PROXY_URL" "$HOOK_CMD" <<'PYEOF'
import sys, json, os

settings_path = sys.argv[1]
proxy_url     = sys.argv[2]
hook_cmd      = sys.argv[3]

import re
with open(settings_path, 'r') as f:
    raw = f.read()
# Strip trailing commas before ] or } (settings.json uses JSONC-style trailing commas)
raw = re.sub(r',(\s*[}\]])', r'\1', raw)
settings = json.loads(raw)

changed = []

# -- env.ANTHROPIC_BASE_URL --
env = settings.setdefault('env', {})
if env.get('ANTHROPIC_BASE_URL') == proxy_url:
    print(f"  ✓ ANTHROPIC_BASE_URL already set to {proxy_url}")
else:
    env['ANTHROPIC_BASE_URL'] = proxy_url
    changed.append(f"  + ANTHROPIC_BASE_URL set to {proxy_url}")

# -- SessionStart hook --
hooks     = settings.setdefault('hooks', {})
ss_groups = hooks.setdefault('SessionStart', [])

# Check if a hook mentioning our health endpoint already exists
proxy_hook_present = any(
    any(
        'llm-proxy' in h.get('command', '') or
        '/health' in h.get('command', '') and 'llm-privacy' in h.get('command', '')
        for h in grp.get('hooks', [])
    )
    for grp in ss_groups
)

if proxy_hook_present:
    print("  ✓ SessionStart proxy hook already present")
else:
    ss_groups.append({'hooks': [{'type': 'command', 'command': hook_cmd}]})
    changed.append("  + SessionStart hook added (auto-start proxy on session open)")

if changed:
    # Write back with 2-space indent, preserving order
    with open(settings_path, 'w') as f:
        json.dump(settings, f, indent=2)
        f.write('\n')
    for msg in changed:
        print(msg)
    print(f"  ✓ {settings_path} updated")
else:
    print("  ✓ settings.json already up to date — no changes needed")
PYEOF
fi

# ── Done ───────────────────────────────────────────────────────────────────

echo ""
echo "=== Setup complete ==="
echo ""
echo "IMPORTANT: Load the new keys into your current shell:"
echo ""
echo "  source ~/.bashrc"
echo ""
echo "Verify the proxy starts correctly:"
echo ""
echo "  ${INSTALL_PATH}/proxy.sh start"
echo "  ${INSTALL_PATH}/proxy.sh status"
echo ""
if [ -f "$CLAUDE_SETTINGS" ]; then
  echo "Claude Code is already configured. Restart Claude Code to pick up changes."
  echo ""
fi
