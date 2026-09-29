#!/usr/bin/env bash
# Scenario wrapper: failed renewal via test clock. Needs the target up (chaos/targets/<target>.sh up) and a populated .env.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
exec chaos/node_modules/.bin/tsx chaos/src/run.ts renewal-failure
