#!/usr/bin/env bash
# Start llm-privacy-proxy, loading LLM_PRIVACY env vars even in
# non-interactive shells (bypasses the interactive guard in ~/.bashrc).
set -euo pipefail

while IFS= read -r line; do
  case "$line" in
    'export LLM_PRIVACY'*) eval "$line" ;;
  esac
done < "$HOME/.bashrc"

SCRIPT_DIR="$(cd "$(dirname "$0")"; pwd)"
exec bun "$SCRIPT_DIR/src/index.ts"
