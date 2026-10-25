# Env for the Supabase target (local `supabase start`): its own Postgres on :54322, functions on :54321.
export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
export WEBHOOK_URL="http://127.0.0.1:54321/functions/v1/stripe-webhook"
if [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ] && command -v supabase >/dev/null 2>&1; then
  SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o env 2>/dev/null | sed -n 's/^SERVICE_ROLE_KEY="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p')"
  export SUPABASE_SERVICE_ROLE_KEY
fi
export RECONCILE_CMD='curl -sf -X POST -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" "http://127.0.0.1:54321/functions/v1/stripe-reconcile?trigger=cli" > "$RECONCILE_REPORT_PATH"'
