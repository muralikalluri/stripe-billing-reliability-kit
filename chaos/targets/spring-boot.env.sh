# Env for the Spring Boot target: its OWN database on the same Postgres server (Flyway owns the schema),
# so its rows never mix with the Next.js ones. Overrides whatever .env says about DATABASE_URL.
_pgport="${POSTGRES_PORT:-5432}"
export SPRING_DATASOURCE_URL="jdbc:postgresql://localhost:${_pgport}/pagemint_spring"
export DATABASE_URL="postgres://${POSTGRES_USER:-pagemint}:${POSTGRES_PASSWORD:-pagemint_local_only}@localhost:${_pgport}/pagemint_spring"
export WEBHOOK_URL="http://localhost:3200/api/webhooks/stripe"
export SERVER_PORT=3200
export DISABLE_SCHEDULE=1
# Local-only placeholder; the chaos scenarios never call the JWT-protected endpoints.
export JWT_SECRET="${JWT_SECRET:-local-only-chaos-jwt-secret-placeholder-32b}"
export RECONCILE_CMD="java -jar spring-boot/target/pagemint-billing.jar --reconcile"
