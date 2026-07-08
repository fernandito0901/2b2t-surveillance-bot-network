#!/bin/bash
# ops/deploy.sh — safe deploy of code changes to the live 2b2t box.
# Runs the guard checks, ships code (NEVER data/ or secrets), and restarts ONLY
# the Node app. ZenithProxy tmux sessions are untouched and survive the restart.
#
# Usage (from the repo root, on the machine holding the pem key):
#   HOST=admin@YOUR_SERVER_IP KEY=./LightsailDefaultKey-us-east-1.pem bash ops/deploy.sh
#
# Frontend-only changes (dashboard/public/*) don't strictly need the restart — a
# hard browser refresh picks them up — but restarting is harmless (bots survive).
set -euo pipefail
HOST="${HOST:-admin@YOUR_SERVER_IP}"
KEY="${KEY:-./LightsailDefaultKey-us-east-1.pem}"
REMOTE="~/2b2t"

echo "=== [1] guard: node --check every tracked .js ==="
# NOTE: `find -exec node --check {} \;` exits 0 even when a check fails (find ignores the
# -exec status), so `set -e` would NOT catch a syntax error and the deploy would ship broken
# JS and restart the service. Pipe through xargs, which DOES propagate a non-zero status.
find . -type f -name '*.js' \
  -not -path './node_modules/*' -not -path './data/*' -print0 \
  | xargs -0 -n1 node --check
echo "  all .js parse OK"

echo "=== [2] guard: unit tests ==="
npm test

echo "=== [3] ship code (excludes data/, node_modules/, secrets) ==="
# tar the code and extract on the box — atomic-ish, no partial file soup, works from Git Bash.
tar czf - \
  --exclude='./node_modules' --exclude='./data' --exclude='*.pem' \
  --exclude='./.env' --exclude='./.git' \
  index.js config.js state.js package.json \
  lib auth bot proxy metrics logging cartography dashboard ops \
  ARCHITECTURE.md PROJECT_OVERVIEW.md \
  | ssh -i "$KEY" -o StrictHostKeyChecking=no "$HOST" "tar xzf - -C $REMOTE"
echo "  code shipped"

echo "=== [4] restart ONLY the Node app (ZenithProxy tmux sessions are untouched) ==="
ssh -i "$KEY" -o StrictHostKeyChecking=no "$HOST" 'sudo systemctl restart 2b2t-app && sleep 3 && systemctl is-active 2b2t-app'

echo "=== [5] post-deploy health ==="
ssh -i "$KEY" -o StrictHostKeyChecking=no "$HOST" '
  echo "tmux (must still show all 4):"; tmux ls;
  echo "dashboard:"; curl -s -o /dev/null -w "  HTTP %{http_code}\n" http://127.0.0.1:3000/login.html;
  echo "recent log:"; tail -n 8 ~/2b2t/app.log'
echo "DONE."
