import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import Stripe from "stripe";
import { makeDb } from "@/db/client";
import { customers, users } from "@/db/schema";

export const WEBHOOK_SECRET = "whsec_test_fixture_not_real";
export const stripeOffline = new Stripe("sk_test_fixture_not_real");

export async function startDb() {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  const db = makeDb(pool);
  await migrate(db, { migrationsFolder: "./drizzle" });
  return {
    container,
    pool,
    db,
    url: container.getConnectionUri(),
    async stop() {
      await pool.end();
      await container.stop();
    },
  };
}

export function signed(payload: object, secret = WEBHOOK_SECRET) {
  const body = JSON.stringify(payload);
  const header = stripeOffline.webhooks.generateTestHeaderString({ payload: body, secret });
  return { body, header };
}

export function fakeEvent(id: string, type: string, object: Record<string, unknown>, created = 1_700_000_000) {
  return { id, object: "event", type, created, data: { object }, livemode: false } as unknown as Stripe.Event;
}

export async function seedUser(db: ReturnType<typeof makeDb>, id: string, stripeCustomerId?: string) {
  await db.insert(users).values({ id, email: `${id}@example.com` });
  if (stripeCustomerId) await db.insert(customers).values({ userId: id, stripeCustomerId });
}

export function fakeSubscription(over: Partial<{ id: string; customer: string; status: string; price: string; quantity: number; userMeta: string; start: number; end: number; cancelAtPeriodEnd: boolean }> = {}) {
  return {
    id: over.id ?? "sub_test_1",
    customer: over.customer ?? "cus_test_1",
    status: over.status ?? "active",
    cancel_at_period_end: over.cancelAtPeriodEnd ?? false,
    cancel_at: null,
    metadata: over.userMeta ? { user_id: over.userMeta } : {},
    items: {
      data: [{ price: { id: over.price ?? "price_pro_m" }, quantity: over.quantity ?? 1, current_period_start: over.start ?? 1_700_000_000, current_period_end: over.end ?? 4_102_444_800 }],
    },
  } as unknown as Stripe.Subscription;
}
