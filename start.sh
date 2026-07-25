#!/bin/sh
# Starts the Quantinno Tax-Neutral Transition Planner at http://localhost:4173
# Finds a node binary even if node is not on PATH.
cd "$(dirname "$0")"

if command -v node >/dev/null 2>&1; then
  NODE_BIN="node"
elif [ -x "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ]; then
  NODE_BIN="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
elif [ -x /opt/homebrew/bin/node ]; then
  NODE_BIN="/opt/homebrew/bin/node"
elif [ -x /usr/local/bin/node ]; then
  NODE_BIN="/usr/local/bin/node"
else
  echo "No node binary found. Install Node.js (https://nodejs.org) and retry." >&2
  exit 1
fi

exec "$NODE_BIN" server.js
