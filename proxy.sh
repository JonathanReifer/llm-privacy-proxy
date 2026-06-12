#!/usr/bin/env bash
# proxy.sh — manage the llm-privacy-proxy daemon
# Usage: proxy.sh {start|stop|restart|status|start-claude|start-ollama}

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")"; pwd)"
LLM_PRIVACY_DIR="${LLM_PRIVACY_DIR:-$HOME/.llm-privacy}"
PID_FILE="${LLM_PRIVACY_DIR}/.proxy.pid"
LOG_FILE="${LLM_PRIVACY_DIR}/proxy.log"
PROXY_PORT="${LLM_PROXY_PORT:-4444}"
PROXY_URL="http://localhost:${PROXY_PORT}"
STOP_TIMEOUT=10   # seconds before SIGKILL fallback

# Load LLM_PRIVACY_* vars for non-interactive shells
load_env() {
  local env_file="${LLM_PRIVACY_DIR}/.env.sh"
  if [ -f "$env_file" ]; then
    # shellcheck disable=SC1090
    source "$env_file"
  fi
}

is_running() {
  local pid
  # Primary check: PID file
  pid="$(cat "$PID_FILE" 2>/dev/null)" && kill -0 "$pid" 2>/dev/null && return 0
  # Fallback: if port is already bound (e.g. after PID file lost or proxy started
  # outside proxy.sh), detect the listener and adopt it into the PID file.
  if [[ "$(uname -s)" == "Darwin" ]]; then
    pid="$(lsof -ti ":${PROXY_PORT}" 2>/dev/null | head -1)"
  else
    pid="$(lsof -ti "tcp:${PROXY_PORT}" -sTCP:LISTEN 2>/dev/null | head -1)"
    if [ -z "$pid" ]; then
      pid="$(ss -tlnp 2>/dev/null | grep ":${PROXY_PORT}" | grep -oP 'pid=\K[0-9]+' | head -1)"
    fi
  fi
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "$pid" > "$PID_FILE"
    return 0
  fi
  return 1
}

get_pid() {
  cat "$PID_FILE" 2>/dev/null || echo ""
}

cmd_start() {
  if is_running; then
    echo "  ✓ Proxy already running (PID $(get_pid))"
    return 0
  fi

  load_env
  mkdir -p "$LLM_PRIVACY_DIR"
  nohup bun "$SCRIPT_DIR/src/index.ts" >> "$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"

  # Wait up to 5s for the health endpoint to respond
  local i=0
  while [ $i -lt 10 ]; do
    if curl -sf "${PROXY_URL}/health" > /dev/null 2>&1; then
      echo "  ✓ Proxy started (PID ${pid}) → ${PROXY_URL}"
      return 0
    fi
    sleep 0.5
    i=$((i + 1))
  done

  echo "  ! Proxy started (PID ${pid}) but health check timed out — check ${LOG_FILE}"
}

cmd_stop() {
  if ! is_running; then
    echo "  ✓ Proxy not running"
    rm -f "$PID_FILE"
    return 0
  fi

  local pid
  pid="$(get_pid)"
  kill -TERM "$pid" 2>/dev/null

  local i=0
  while [ $i -lt $((STOP_TIMEOUT * 2)) ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      echo "  ✓ Proxy stopped (was PID ${pid})"
      return 0
    fi
    sleep 0.5
    i=$((i + 1))
  done

  # Process didn't exit cleanly — force kill
  kill -KILL "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "  ! Proxy force-killed after ${STOP_TIMEOUT}s (was PID ${pid})"
}

cmd_restart() {
  cmd_stop
  cmd_start
}

cmd_status() {
  if is_running; then
    local pid
    pid="$(get_pid)"
    echo "  Status:   running (PID ${pid})"
    health="$(curl -sf "${PROXY_URL}/health" 2>/dev/null)" || health=""
    if [ -n "$health" ]; then
      echo "  URL:      ${PROXY_URL}"
      echo "$health" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f\"  Version:  {d.get('version','?')}\")
print(f\"  Target:   {d.get('target','?')}\")
print(f\"  Vault:    {d.get('vaultMode','?')}  ({d.get('vaultPath','?')})\")
print(f\"  Traffic:  {d.get('requests',0)} requests  {d.get('tokenized',0)} tokenized  {d.get('detokenized',0)} detokenized\")
print(f\"  Since:    {d.get('startedAt','?')}\")
" 2>/dev/null || echo "  Health:   $health"
    else
      echo "  Health:   not responding on ${PROXY_URL}"
    fi
  else
    echo "  Status:   stopped"
    if [ -f "$PID_FILE" ]; then
      rm -f "$PID_FILE"
      echo "            (stale PID file removed)"
    fi
  fi
}

cmd_start_claude() {
  PID_FILE="${LLM_PRIVACY_DIR}/.proxy-claude.pid"
  LOG_FILE="${LLM_PRIVACY_DIR}/proxy-claude.log"
  PROXY_PORT="4444"
  PROXY_URL="http://localhost:4444"
  export LLM_PROXY_PORT="4444"
  export PROXY_BACKEND="anthropic"
  unset LLM_PROXY_TARGET 2>/dev/null || true
  cmd_start
}

cmd_start_ollama() {
  PID_FILE="${LLM_PRIVACY_DIR}/.proxy-ollama.pid"
  LOG_FILE="${LLM_PRIVACY_DIR}/proxy-ollama.log"
  PROXY_PORT="4445"
  PROXY_URL="http://localhost:4445"
  export LLM_PROXY_PORT="4445"
  export PROXY_BACKEND="ollama"
  cmd_start
}

case "${1:-}" in
  start)         cmd_start         ;;
  stop)          cmd_stop          ;;
  restart)       cmd_restart       ;;
  status)        cmd_status        ;;
  start-claude)  cmd_start_claude  ;;
  start-ollama)  cmd_start_ollama  ;;
  *)
    echo "Usage: $(basename "$0") {start|stop|restart|status|start-claude|start-ollama}"
    exit 1
    ;;
esac
