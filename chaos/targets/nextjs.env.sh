# Env for the Next.js target: everything comes from .env (DATABASE_URL, keys). The app listens on :3100
# (see chaos/targets/nextjs.sh); the harness derives WEBHOOK_URL from APP_PORT.
export RECONCILE_CMD="${RECONCILE_CMD:-npm --prefix nextjs run --silent reconcile}"
