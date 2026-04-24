#!/usr/bin/env bash
# Starts both the TanStack Start UI server and the Hlid WebSocket server.
# Called by the Windows Task Scheduler task; do not rename or move without
# updating Register-HlidTask.ps1.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$REPO_DIR/logs"
mkdir -p "$LOG_DIR"

LOG="$LOG_DIR/hlid.log"
echo "--- hlid start $(date) ---" >> "$LOG"

# Bun isn't on the default PATH inside Task Scheduler's WSL invocation
export PATH="$HOME/.bun/bin:$PATH"

cd "$REPO_DIR"

# Kill any previous instances that may have been left running
pkill -f "vite dev" 2>/dev/null || true
pkill -f "src/server/index.ts" 2>/dev/null || true

# Start UI server (TanStack Start / Vite) in background
bun run dev >> "$LOG" 2>&1 &
UI_PID=$!

# Give Vite a moment to bind before starting the WS server
sleep 2

# Start WebSocket server in background
bun run dev:server >> "$LOG" 2>&1 &
WS_PID=$!

echo "UI pid=$UI_PID  WS pid=$WS_PID" >> "$LOG"

# Wait for either process to exit, then kill the other and let Task Scheduler
# restart the whole task on failure. `wait -n` requires bash 5.1+ (WSL Ubuntu 22+).
wait -n $UI_PID $WS_PID
echo "--- one process exited, shutting down $(date) ---" >> "$LOG"
kill $UI_PID $WS_PID 2>/dev/null || true
exit 1
