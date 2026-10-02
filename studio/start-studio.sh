#!/usr/bin/env bash
# Start Fabric MCP Studio on macOS or Linux.
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or later is required. Install the LTS version from https://nodejs.org and run this again." >&2
  exit 1
fi
if [ ! -d node_modules/@github/copilot-sdk ]; then
  echo "Installing Fabric MCP Studio dependencies (first run only)..."
  npm install --no-audit --no-fund
fi
exec node server/main.mjs "$@"
