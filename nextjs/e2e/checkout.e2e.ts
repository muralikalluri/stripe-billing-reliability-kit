import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import Stripe from "stripe";

/**
 * LIVE end to end (Stripe test mode): pricing -> hosted Checkout with a test card -> webhook -> access.
 * Access must arrive through the webhook worker; the success redirect alone proves nothing.
 * Creates one throwaway user and Stripe customer and deletes both afterwards.
 */
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function fillHostedCheckout(page: Page) {
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 60_000 });
  await page.locator("#cardNumber").fill("4242424242424242");
  await page.locator("#cardExpiry").fill("12 / 34");
  await page.locator("#cardCvc").fill("123");
  await page.locator("#billingName").fill("E2E Test User");
  await expect(page.locator("#enableStripePass")).not.toBeChecked(); // do not opt in to Link
  await page.getByTestId("hosted-payment-submit-button").click();
}

test.afterAll(async () => {
  await pool.end();
});

test("pricing -> hosted Checkout (test card) -> webhook -> access -> billing portal", async ({ page }) => {
  const email = `e2e-${Date.now().toString(36)}@example.com`;
  const startedAt = new Date();
  let userId: string | undefined;
  let customerId: string | undefined;
  try {
    // 1. Sign in (demo auth, dev server only).
    await page.goto("/login");
    await page.getByPlaceholder("you@example.com").fill(email);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveURL(/\/pricing/);
    userId = (await pool.query("select id from users where email = $1", [email])).rows[0]?.id;
    expect(userId, "the demo login created the user").toBeTruthy();

    // 2. Before paying there is no access.
    const before = await (await page.request.get("/api/me/entitlement")).json();
    expect(before.access).toBe(false);

    // 3. Subscribe to Pro monthly and pay on the hosted Checkout page with the 4242 test card.
    await page.locator("li", { hasText: "Pro monthly" }).getByRole("button", { name: "Subscribe" }).click();
    await fillHostedCheckout(page);

    // 4. Back on the success page. It only reports server state; the webhook worker is what grants access.
    await page.waitForURL(/\/checkout\/success/, { timeout: 120_000 });
    await expect(page.getByText(/Your\s+pro\s+plan is active/i)).toBeVisible({ timeout: 120_000 });

    // 5. The database agrees: subscription (14-day trial), entitlement, and processed webhook events.
    const sub = (await pool.query("select status, price_id from subscriptions where user_id = $1", [userId])).rows[0];
    expect(sub.status).toBe("trialing");
    expect(sub.price_id).toBe(process.env.STRIPE_PRICE_PRO_MONTHLY);
    const ent = (await pool.query("select plan, valid_until from entitlements where user_id = $1", [userId])).rows[0];
    expect(ent.plan).toBe("pro");
    expect(new Date(ent.valid_until).getTime()).toBeGreaterThan(Date.now());
    // Events keep arriving after access is granted (the first one processed already synced the subscription),
    // so wait until every event since the start has settled, and none may have failed.
    await expect
      .poll(async () => (await pool.query("select status from webhook_events where received_at >= $1", [startedAt])).rows.map((r) => r.status).sort().join(","), { timeout: 60_000 })
      .toMatch(/^(processed,?)+$/);

    // 6. The account page and the entitlement API agree, uncached.
    await page.goto("/account");
    await expect(page.getByText("pro", { exact: false }).first()).toBeVisible();
    const after = await page.request.get("/api/me/entitlement");
    expect((await after.json()).access).toBe(true);
    expect(after.headers()["cache-control"]).toContain("no-store");

    // 7. The Customer Portal opens for this customer's subscription.
    await page.getByRole("button", { name: "Manage billing" }).click();
    await page.waitForURL(/billing\.stripe\.com/, { timeout: 60_000 });
    await expect(page.getByText(/PageMint Pro/).first()).toBeVisible({ timeout: 60_000 });
    customerId = (await pool.query("select stripe_customer_id from customers where user_id = $1", [userId])).rows[0]?.stripe_customer_id;
  } finally {
    // Cleanup: Stripe first (cancels the subscription), then our rows.
    customerId ??= userId ? (await pool.query("select stripe_customer_id from customers where user_id = $1", [userId])).rows[0]?.stripe_customer_id : undefined;
    if (customerId) await stripe.customers.del(customerId).catch(() => {});
    if (userId) {
      await pool.query("delete from entitlements where user_id = $1", [userId]);
      await pool.query("delete from subscriptions where user_id = $1", [userId]);
      await pool.query("delete from customers where user_id = $1", [userId]);
      await pool.query("delete from users where id = $1", [userId]);
    }
    await pool.query("delete from webhook_events where received_at >= $1", [startedAt]);
  }
});
