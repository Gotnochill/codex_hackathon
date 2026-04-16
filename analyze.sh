#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# nvm.sh parses shell arguments on source, so stash user args first.
USER_ARGS=("$@")
set --

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh" --no-use
else
  echo "[analyze.sh] nvm not found at $NVM_DIR/nvm.sh" >&2
  echo "Install nvm or open a shell where Node 20 is already available." >&2
  exit 1
fi

if ! command -v nvm >/dev/null 2>&1; then
  echo "[analyze.sh] nvm command is unavailable after sourcing $NVM_DIR/nvm.sh" >&2
  exit 1
fi

if ! nvm use 20 >/dev/null 2>&1; then
  echo "[analyze.sh] Node 20 is not installed in nvm, installing it now..." >&2
  nvm install 20 >/dev/null
  nvm use 20 >/dev/null
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[analyze.sh] node is not available even after nvm use 20" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[analyze.sh] npm is not available even after nvm use 20" >&2
  exit 1
fi

cd "$ROOT_DIR"
if [ ! -d "$ROOT_DIR/node_modules" ]; then
  echo "[analyze.sh] Installing project dependencies..." >&2
  npm install
fi

set -- "${USER_ARGS[@]}"
exec node scripts/restart-open-track.js "$@"
