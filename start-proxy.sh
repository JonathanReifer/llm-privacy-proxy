#!/usr/bin/env bash
# Thin shim — use proxy.sh for full start/stop/restart/status control.
exec "$(cd "$(dirname "$0")"; pwd)/proxy.sh" start "$@"
