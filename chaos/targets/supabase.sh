#!/usr/bin/env bash
# Start/stop the Supabase implementation (local stack + Edge Functions + a worker poller) for the chaos scenarios.
# usage: chaos/targets/supabase.sh up|down     Needs Docker and the Supabase CLI.
set -euo pipefail
cd "$(dirname "$0")/../.."
export CHAOS_TARGET=supabase
. chaos/load-env.sh
RUN=chaos/.run
mkdir -p "$RUN"

case "${1:-}" in
  up)
    supabase start >"$RUN/supabase-start.log" 2>&1 || { echo "supabase start failed; see $RUN/supabase-start.log"; exit 1; }
    supabase db reset >"$RUN/supabase-reset.log" 2>&1     # local only: applies supabase/migrations to a clean DB
    . chaos/targets/supabase.env.sh                       # picks up the service-role key now that the stack is up
    # Functions get the same Stripe test key, listener secret and prices as the other targets (from .env).
    { echo "STRIPE_SECRET_KEY=$STRIPE_SECRET_KEY"; echo "STRIPE_WEBHOOK_SECRET=$STRIPE_WEBHOOK_SECRET"
      echo "STRIPE_PRICE_PRO_MONTHLY=${STRIPE_PRICE_PRO_MONTHLY:-}"; echo "STRIPE_PRICE_PRO_YEARLY=${STRIPE_PRICE_PRO_YEARLY:-}"
      echo "STRIPE_PRICE_TEAM_SEAT=${STRIPE_PRICE_TEAM_SEAT:-}"; } > supabase/functions/.env
    nohup supabase functions serve --env-file supabase/functions/.env >"$RUN/functions.log" 2>&1 </dev/null &
    echo $! >"$RUN/functions.pid"
    for i in $(seq 1 90); do
      code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$WEBHOOK_URL" || true)
      [ "$code" = "400" ] && break; sleep 1                # 400 = function up, rejected the unsigned request
    done
    [ "$code" = "400" ] || { echo "functions did not start; see $RUN/functions.log"; exit 1; }
    # Safety-net worker (pg_cron's job in production): retries failed events every 2 s.
    nohup bash -c 'while true; do curl -s -o /dev/null -X POST -H "Authorization: Bearer '"$SUPABASE_SERVICE_ROLE_KEY"'" http://127.0.0.1:54321/functions/v1/stripe-worker; sleep 2; done' \
      >"$RUN/worker-loop.log" 2>&1 </dev/null &
    echo $! >"$RUN/worker-loop.pid"
    echo "supabase target up (functions on :54321, db on :54322)" ;;
  down)
    for f in worker-loop functions; do
      [ -f "$RUN/$f.pid" ] && pkill -P "$(cat "$RUN/$f.pid")" 2>/dev/null; [ -f "$RUN/$f.pid" ] && kill "$(cat "$RUN/$f.pid")" 2>/dev/null; rm -f "$RUN/$f.pid"
    done
    echo "supabase target down (run 'supabase stop' to stop the local stack)" ;;
  *) echo "usage: $0 up|down"; exit 2 ;;
esac
