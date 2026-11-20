#!/usr/bin/env bash
# Headless-browser smoke test against the dev environment (dev/compose.yml).
# Runs Playwright in a container on the dev network; screenshots go to
# dev/e2e/out/. Run dev/seed.sh first. Note: it deletes tools/busybox:old.
set -euo pipefail
cd "$(dirname "$0")/e2e"
mkdir -p out
docker run --rm --network registry-manager-dev_default \
  -v "$PWD:/work" -w /work \
  mcr.microsoft.com/playwright:v1.56.0-noble \
  sh -c '[ -d node_modules/playwright ] || npm i --silent --no-save playwright@1.56.0 >/dev/null 2>&1; node smoke.mjs'
