#!/usr/bin/env bash
# Sourced by every chaos wrapper (from the repo root): loads .env, then applies the target's own env file.
# CHAOS_TARGET chosen by the caller survives .env, so .env can never silently switch which implementation is tested.
#   CHAOS_TARGET=spring-boot chaos/run-all.sh
_target="${CHAOS_TARGET:-nextjs}"
set -a
[ -f .env ] && . ./.env
set +a
export CHAOS_TARGET="$_target"
if [ -f "chaos/targets/$CHAOS_TARGET.env.sh" ]; then
  # shellcheck disable=SC1090
  . "chaos/targets/$CHAOS_TARGET.env.sh"
else
  echo "unknown CHAOS_TARGET '$CHAOS_TARGET' (no chaos/targets/$CHAOS_TARGET.env.sh)" >&2
  return 2 2>/dev/null || exit 2
fi
