#!/usr/bin/env bash
# Scenario wrapper: missed webhook, then reconcile. Needs the target up (chaos/targets/<target>.sh up) and a populated .env.
set -euo pipefail
cd "$(dirname "$0")/.."
. chaos/load-env.sh
exec chaos/node_modules/.bin/tsx chaos/src/run.ts missed-webhook
