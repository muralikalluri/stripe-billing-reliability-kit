#!/usr/bin/env bash
# Start/stop the Spring Boot implementation (own database + app on :3200) for the chaos scenarios.
# usage: chaos/targets/spring-boot.sh up|down
set -euo pipefail
cd "$(dirname "$0")/../.."
export CHAOS_TARGET=spring-boot
. chaos/load-env.sh
RUN=chaos/.run
mkdir -p "$RUN"

case "${1:-}" in
  up)
    docker compose up -d --wait postgres
    # Own database; Flyway creates the schema on first start (baseline-on-migrate is off on purpose).
    docker compose exec -T postgres psql -U "${POSTGRES_USER:-pagemint}" -d postgres -Atc \
      "select 1 from pg_database where datname='pagemint_spring'" | grep -q 1 \
      || docker compose exec -T postgres psql -U "${POSTGRES_USER:-pagemint}" -d postgres -c "create database pagemint_spring"
    mvn -q -f spring-boot/pom.xml package -DskipTests >"$RUN/spring-build.log" 2>&1
    # fully detached (all fds redirected) so callers piping our output don't hang
    nohup java -jar spring-boot/target/pagemint-billing.jar >"$RUN/spring.log" 2>&1 </dev/null &
    echo $! >"$RUN/spring.pid"
    for i in $(seq 1 60); do curl -s -o /dev/null -X POST "http://localhost:3200/api/webhooks/stripe" && break; sleep 1; done
    curl -s -o /dev/null -X POST "http://localhost:3200/api/webhooks/stripe" || { echo "spring app did not start; see $RUN/spring.log"; exit 1; }
    echo "spring-boot target up on :3200" ;;
  down)
    [ -f "$RUN/spring.pid" ] && kill "$(cat "$RUN/spring.pid")" 2>/dev/null; rm -f "$RUN/spring.pid"
    echo "spring-boot target down (postgres left running)" ;;
  *) echo "usage: $0 up|down"; exit 2 ;;
esac
