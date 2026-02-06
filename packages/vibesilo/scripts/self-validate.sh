#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)

cd "$ROOT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required." >&2
  exit 1
fi

echo "Building sandbox CLI..."
npm run build >/dev/null

echo "Running allowNet smoke test..."
node dist/cli.js run \
  --image curlimages/curl:8.6.0 \
  --allow example.com \
  -- curl -s https://example.com >/dev/null

echo "Validating blocked host..."
set +e
BLOCK_OUTPUT=$(node dist/cli.js run \
  --image curlimages/curl:8.6.0 \
  --allow example.com \
  -- curl -s https://example.org)
STATUS=$?
set -e

if echo "$BLOCK_OUTPUT" | grep -q "blocked by agent-sandbox"; then
  echo "Blocked host check passed."
else
  echo "Blocked host check failed." >&2
  exit 1
fi

echo "Validating secret injection..."
node scripts/validate-secrets.mjs

echo "Building GH CLI image..."
docker build -f examples/Dockerfile.gh -t agent-sandbox-gh . >/dev/null

echo "Validating GH CLI injection (dummy token)..."
node scripts/validate-gh.mjs

echo "Self-validate complete."
