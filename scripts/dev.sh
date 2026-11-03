#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export REQUIRE_ENERGY=true
export STOMACH_URL=http://127.0.0.1:3003
export LEGS_URL=http://127.0.0.1:3001
export HANDS_URL=http://127.0.0.1:3002
export EYES_URL=http://127.0.0.1:3004
export HEAD_URL=http://127.0.0.1:3005
export PUBLIC_LEGS_URL=http://127.0.0.1:3001
export PUBLIC_HANDS_URL=http://127.0.0.1:3002
export PUBLIC_STOMACH_URL=http://127.0.0.1:3003
export PUBLIC_EYES_URL=http://127.0.0.1:3004
export PUBLIC_HEAD_URL=http://127.0.0.1:3005

pids=()
cleanup() {
  for pid in "${pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

start() {
  local dir="$1"
  local port="$2"
  (cd "$ROOT/$dir" && PORT="$port" node app.js) &
  pids+=("$!")
}

start three 3003
start one 3001
start two 3002
start four 3004
start five 3005

echo "Robot lab is starting."
echo "Open the whole robot at http://127.0.0.1:3005"
wait
