#!/usr/bin/env bash
# Start/stop the Next.js implementation (app + worker + postgres) for the chaos scenarios.
# usage: chaos/targets/nextjs.sh up|down
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -f .env ] || { echo ".env missing (see docs/stripe-cli.md)"; exit 1; }
set -a; . ./.env; set +a
RUN=chaos/.run
mkdir -p "$RUN"
PORT="${APP_PORT:-3100}"   # 3000 is often taken by other local containers

case "${1:-}" in
  up)
    docker compose up -d --wait postgres
    npm --prefix nextjs run --silent db:migrate
    npm --prefix nextjs run --silent build >"$RUN/build.log" 2>&1
    # fully detached (all fds redirected) so callers piping our output don't hang
    cd nextjs
    APP_URL="http://localhost:$PORT" nohup npx next start -p "$PORT" >"../$RUN/app.log" 2>&1 </dev/null &
    echo $! >"../$RUN/app.pid"
    # DISABLE_SCHEDULE keeps the nightly reconcile from repairing state mid-scenario
    DISABLE_SCHEDULE=1 nohup npm run --silent worker >"../$RUN/worker.log" 2>&1 </dev/null &
    echo $! >"../$RUN/worker.pid"
    cd ..
    for i in $(seq 1 60); do curl -s -o /dev/null "http://localhost:$PORT/login" && break; sleep 1; done
    curl -s -o /dev/null "http://localhost:$PORT/login" || { echo "app did not start; see $RUN/app.log"; exit 1; }
    sleep 3; echo "nextjs target up on :$PORT" ;;
  down)
    for f in app worker; do
      [ -f "$RUN/$f.pid" ] && pkill -P "$(cat "$RUN/$f.pid")" 2>/dev/null; [ -f "$RUN/$f.pid" ] && kill "$(cat "$RUN/$f.pid")" 2>/dev/null; rm -f "$RUN/$f.pid"
    done
    echo "nextjs target down (postgres left running)" ;;
  *) echo "usage: $0 up|down"; exit 2 ;;
esac
