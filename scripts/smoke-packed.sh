#!/usr/bin/env bash
#
# Pack the package, install it into an empty directory, and ask the server for
# an MCP initialize.
#
# This exists because the repository is not a realistic environment. Its
# devDependencies are present, so a runtime import that is only reachable
# through one resolves here and fails for everyone else. 2.0.0 shipped exactly
# that -- the generated gRPC client imports `@bufbuild/protobuf/wire`, which was
# reachable only through ts-proto -- and every other check passed: it compiled,
# `npm pack` listed the right files, and the server ran from the working tree.
# Checking what is in the package is not the same as installing it.
#
# Runs on Linux happily: this proves the module graph resolves and the server
# answers, neither of which needs a simulator.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

npm run build >/dev/null

TGZ="$(npm pack --silent | tail -1)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; rm -f "$ROOT/$TGZ"' EXIT

cp "$TGZ" "$WORK/"
cd "$WORK"
npm init -y >/dev/null
npm install "./$TGZ" --no-audit --no-fund >/dev/null

INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'
RESPONSE="$(printf '%s\n' "$INIT" \
  | node node_modules/ios-multi-simulator-mcp/build/index.js --stdio 2>&1 || true)"

echo "${RESPONSE:0:400}"

if ! grep -q '"serverInfo"' <<<"$RESPONSE"; then
  echo "ERROR: the packed package did not answer an MCP initialize; it is not installable." >&2
  exit 1
fi

echo "OK: packed package installs and answers initialize."
