#!/usr/bin/env bash
# Run all five scenarios against the target and regenerate docs/chaos.md from the results.
set -euo pipefail
cd "$(dirname "$0")/.."
. chaos/load-env.sh
chaos/node_modules/.bin/tsx chaos/src/run.ts all || RC=$?
chaos/node_modules/.bin/tsx chaos/src/render.ts
exit "${RC:-0}"
