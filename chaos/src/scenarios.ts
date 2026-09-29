import {
  count, createFixture, createSubscription, deliver, entRow, eventRow, findEvents, Recorder, runReconcile, setPaymentMethod,
  sign, sleep, startListener, stopListener, subRow, waitAllIdle, waitFor, waitSettled, type Ctx,
} from "./lib.js";

export interface Scenario {
  name: string;
  title: string;
  deliveryMode: string;
  run(ctx: Ctx, rec: Recorder): Promise<void>;
}

const SUB_EVENTS = ["customer.subscription.created", "customer.subscription.updated"];
const nowSec = () => Math.floor(Date.now() / 1000);

// S1 ---------------------------------------------------------------------------------------------
const duplicate: Scenario = {
  name: "duplicate",
  title: "Duplicate delivery",
  deliveryMode: "harness_signed_replay",
  async run(ctx, rec) {
    const since = nowSec();
    const fx = await createFixture(ctx, "duplicate");
    const sub = await createSubscription(ctx, fx);
    const [created] = (await findEvents(ctx, { sinceSec: since, types: ["customer.subscription.created"], subId: sub.id, min: 1 }));
    rec.evidence.event_id = created.id;

    const first = await deliver(ctx, created);
    await waitSettled(ctx, [created.id]);
    const before = await eventRow(ctx, created.id);
    const subBefore = await subRow(ctx, sub.id);
    const second = await deliver(ctx, created);
    const third = await deliver(ctx, created);
    await sleep(3000); // give a (wrongly) queued second job time to run
    const after = await eventRow(ctx, created.id);
    const subAfter = await subRow(ctx, sub.id);

    rec.evidence.http_statuses = [first.status, second.status, third.status];
    rec.check("http_all_200", "3 deliveries of one event all return 200", [first.status, second.status, third.status], [first.status, second.status, third.status].every((s) => s === 200));
    rec.check("one_event_row", "exactly 1 webhook_events row for the event", await count(ctx, "select count(*)::int n from webhook_events where event_id=$1", [created.id]), (await count(ctx, "select count(*)::int n from webhook_events where event_id=$1", [created.id])) === 1);
    rec.check("processed_once", "attempts = 1 (processed exactly once)", after.attempts, after.attempts === 1 && after.status === "processed");
    rec.check("processed_at_unchanged", "processed_at unchanged by the duplicates", String(after.processed_at), String(after.processed_at) === String(before.processed_at));
    rec.check("state_not_rewritten", "subscription row untouched by the duplicates (updated_at unchanged)", String(subAfter.updated_at), String(subAfter.updated_at) === String(subBefore.updated_at));
    rec.check("one_entitlement", "exactly 1 entitlement, plan pro", (await entRow(ctx, fx.userId))?.plan, (await count(ctx, "select count(*)::int n from entitlements where user_id=$1", [fx.userId])) === 1 && (await entRow(ctx, fx.userId)).plan === "pro");
  },
};

// S2 ---------------------------------------------------------------------------------------------
const outOfOrder: Scenario = {
  name: "out-of-order",
  title: "Out-of-order delivery (updated before created)",
  deliveryMode: "harness_signed_replay",
  async run(ctx, rec) {
    const since = nowSec();
    const fx = await createFixture(ctx, "ooo");
    const sub = await createSubscription(ctx, fx);
    await sleep(2200); // event.created has 1s resolution: avoid a tie
    await ctx.stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
    const events = await findEvents(ctx, { sinceSec: since, types: SUB_EVENTS, subId: sub.id, min: 2 });
    const created = events.find((e) => e.type === "customer.subscription.created")!;
    const updated = events.filter((e) => e.type === "customer.subscription.updated").pop()!;
    rec.evidence.created = { id: created.id, created: created.created };
    rec.evidence.updated = { id: updated.id, created: updated.created };
    rec.check("real_order_gap", "created.created < updated.created (a real ordering exists)", [created.created, updated.created], created.created < updated.created);

    await deliver(ctx, updated); // arrives FIRST
    await waitSettled(ctx, [updated.id]);
    await deliver(ctx, created); // arrives late
    await waitSettled(ctx, [created.id]);

    const r1 = await eventRow(ctx, updated.id);
    const r2 = await eventRow(ctx, created.id);
    rec.check("arrival_order", "updated was received before created", [r1.received_at, r2.received_at], new Date(r1.received_at) < new Date(r2.received_at));
    const row = await subRow(ctx, sub.id);
    const live = await ctx.stripe.subscriptions.retrieve(sub.id);
    rec.check("event_clock_not_regressed", "updated_from_event_created stays at the newer event's created", Number(row.updated_from_event_created), Number(row.updated_from_event_created) === updated.created);
    rec.check("matches_stripe", "final row equals Stripe (status, cancel_at_period_end)", [row.status, row.cancel_at_period_end], row.status === live.status && row.cancel_at_period_end === (live.cancel_at_period_end || live.cancel_at != null));
    rec.check("access_kept", "entitlement plan = pro (still paid until period end)", (await entRow(ctx, fx.userId))?.plan, (await entRow(ctx, fx.userId))?.plan === "pro");
  },
};

// S3 ---------------------------------------------------------------------------------------------
const missedWebhook: Scenario = {
  name: "missed-webhook",
  title: "Missed webhook (listener down while the customer pays)",
  deliveryMode: "none (listener stopped; nothing delivered)",
  async run(ctx, rec) {
    // The listener is not running: nothing is delivering webhooks. Confirm a clean baseline first.
    const baseline = runReconcile(ctx);
    rec.check("baseline_no_repairs", "baseline reconcile repairs nothing (clean environment)", baseline.counts.repaired, baseline.counts.repaired === 0);

    const since = nowSec();
    const fx = await createFixture(ctx, "missed");
    const sub = await createSubscription(ctx, fx);
    const events = await findEvents(ctx, { sinceSec: since, types: SUB_EVENTS, subId: sub.id, min: 1 });
    events.forEach((e) => ctx.tracked.eventIds.add(e.id));
    rec.evidence.stripe_event_ids = events.map((e) => e.id);
    await sleep(3000);

    const seen = await count(ctx, "select count(*)::int n from webhook_events where event_id = any($1)", [events.map((e) => e.id)]);
    rec.check("nothing_received", "Stripe has the events, our DB received none", seen, seen === 0);
    rec.check("no_subscription_row", "no subscription row before reconcile", await subRow(ctx, sub.id), (await subRow(ctx, sub.id)) === null);
    rec.check("no_access_before", "user paid but has NO entitlement (the bug)", await entRow(ctx, fx.userId), (await entRow(ctx, fx.userId)) === null);

    await startListener(ctx); // listener comes back; it does not replay the backlog
    const report = runReconcile(ctx);
    const mine = report.drift.filter((d) => d.stripeSubscriptionId === sub.id);
    rec.evidence.reconcile = { counts: report.counts, complete: report.complete, mine };
    rec.check("one_repair", "drift report shows exactly 1 repair, for this subscription (missing_in_db)", { repaired: report.counts.repaired, mine }, report.counts.repaired === 1 && mine.length === 1 && mine[0].kind === "missing_in_db" && mine[0].action === "repaired");
    rec.check("access_restored", "entitlement plan = pro after reconcile", (await entRow(ctx, fx.userId))?.plan, (await entRow(ctx, fx.userId))?.plan === "pro");
    const again = runReconcile(ctx);
    rec.check("second_run_clean", "a second reconcile repairs nothing", again.counts.repaired, again.counts.repaired === 0 && !again.drift.some((d) => d.stripeSubscriptionId === sub.id));
  },
};

// S4 ---------------------------------------------------------------------------------------------
const tamper: Scenario = {
  name: "tamper",
  title: "Tampered payload",
  deliveryMode: "harness_signed_replay",
  async run(ctx, rec) {
    const since = nowSec();
    const fx = await createFixture(ctx, "tamper");
    const sub = await createSubscription(ctx, fx);
    const [ev] = await findEvents(ctx, { sinceSec: since, types: ["customer.subscription.created"], subId: sub.id, min: 1 });
    ctx.tracked.eventIds.add(ev.id);
    const body = JSON.stringify(ev);
    const goodHeader = sign(ctx, body);

    const tampered = await deliver(ctx, ev, { body: body.replace(sub.id, "sub_TAMPERED"), header: goodHeader });
    const reindented = await deliver(ctx, ev, { body: JSON.stringify(ev, null, 2), header: goodHeader });
    const wrongSecret = await deliver(ctx, ev, { header: sign(ctx, body, "whsec_not_the_real_secret") });
    const unsigned = await deliver(ctx, ev, { header: null });
    rec.evidence.http_statuses = { tampered: tampered.status, reindented: reindented.status, wrong_secret: wrongSecret.status, unsigned: unsigned.status };
    rec.check("tampered_400", "body changed after signing -> 400", tampered.status, tampered.status === 400);
    rec.check("reindented_400", "same JSON, different bytes -> 400 (raw body is verified)", reindented.status, reindented.status === 400);
    rec.check("wrong_secret_400", "signed with another secret -> 400", wrongSecret.status, wrongSecret.status === 400);
    rec.check("unsigned_400", "no signature header -> 400", unsigned.status, unsigned.status === 400);
    await sleep(2000);
    rec.check("nothing_processed", "no webhook_events row, no subscription row, no entitlement", {
      events: await count(ctx, "select count(*)::int n from webhook_events where event_id=$1", [ev.id]),
      sub: (await subRow(ctx, sub.id)) !== null,
      ent: (await entRow(ctx, fx.userId)) !== null,
    }, (await count(ctx, "select count(*)::int n from webhook_events where event_id=$1", [ev.id])) === 0 && (await subRow(ctx, sub.id)) === null && (await entRow(ctx, fx.userId)) === null);
    const ok = await deliver(ctx, ev);
    rec.check("control_valid_200", "control: the untouched event is accepted", ok.status, ok.status === 200);
  },
};

// S5 ---------------------------------------------------------------------------------------------
const renewalFailure: Scenario = {
  name: "renewal-failure",
  title: "Renewal failure (test clock + failing card)",
  deliveryMode: "stripe listen (real forwarded events)",
  async run(ctx, rec) {
    const GRACE_MS = 3 * 86400_000; // must equal PAST_DUE_GRACE_MS in derive.ts / the Spring equivalent
    await startListener(ctx);
    const fx = await createFixture(ctx, "renewal", { testClock: true });
    const clockId = fx.clockId!;
    const advance = async (toSec: number) => {
      await ctx.stripe.testHelpers.testClocks.advance(clockId, { frozen_time: toSec });
      await waitFor("test clock ready", async () => (await ctx.stripe.testHelpers.testClocks.retrieve(clockId)).status === "ready", 120_000, 2000);
      await waitAllIdle(ctx);
    };
    const clockNow = async () => (await ctx.stripe.testHelpers.testClocks.retrieve(clockId)).frozen_time;
    // Access "at clock time": validUntil is in test-clock time, so compare it to the clock, not the wall clock.
    const accessAt = async (t: number) => {
      const e = await entRow(ctx, fx.userId);
      return !!e && e.plan !== "free" && !!e.valid_until && new Date(e.valid_until).getTime() > t * 1000;
    };

    const sub = await createSubscription(ctx, fx);
    const row0 = await waitFor("subscription row", async () => subRow(ctx, sub.id), 60_000, 1000);
    const period0End = Math.floor(new Date(row0.current_period_end).getTime() / 1000);
    rec.check("initial_active", "active, plan pro", { status: row0.status, plan: (await entRow(ctx, fx.userId))?.plan }, row0.status === "active" && (await entRow(ctx, fx.userId))?.plan === "pro");

    await setPaymentMethod(ctx, fx.customerId, "pm_card_chargeCustomerFail"); // attaches fine, charges fail
    await advance(period0End + 2 * 3600); // renewal invoice finalizes and the charge fails
    const past = await waitFor("past_due row", async () => { const r = await subRow(ctx, sub.id); return r?.status === "past_due" ? r : null; }, 120_000, 2000);
    const periodStart = Math.floor(new Date(past.current_period_start).getTime() / 1000);
    const ent1 = await entRow(ctx, fx.userId);
    rec.check("past_due_keeps_access", "past_due: still plan pro (grace)", { status: past.status, plan: ent1?.plan }, ent1?.plan === "pro");
    rec.check("grace_anchored_on_period_start", "valid_until = current_period_start + grace", new Date(ent1.valid_until).toISOString(), new Date(ent1.valid_until).getTime() === periodStart * 1000 + GRACE_MS);

    const graceEnd = periodStart + GRACE_MS / 1000;
    await advance(graceEnd - 3600);
    rec.check("access_before_grace_end", "1h before grace ends: access", await accessAt(await clockNow()), await accessAt(await clockNow()));
    await advance(graceEnd + 3600);
    const late = await subRow(ctx, sub.id);
    rec.evidence.status_after_grace = late.status;
    rec.check("no_access_after_grace", "1h after grace ends: NO access (status recorded as evidence)", await accessAt(await clockNow()), !(await accessAt(await clockNow())));

    let finalRow = late;
    for (let i = 0; i < 6 && finalRow.status === "past_due"; i++) {
      await advance((await clockNow()) + 7 * 86400);
      finalRow = await subRow(ctx, sub.id);
    }
    const finalEnt = await entRow(ctx, fx.userId);
    rec.evidence.final_status = finalRow.status;
    rec.check("final_no_access", "after retries are exhausted: plan free", { status: finalRow.status, plan: finalEnt?.plan }, finalEnt?.plan === "free");
    if (finalRow.status !== "unpaid") {
      rec.precondition = `final status was "${finalRow.status}", not "unpaid": set Stripe Dashboard > Billing > Revenue recovery > "mark the subscription as unpaid" to exercise the unpaid path (access is removed either way).`;
    }
  },
};

export const SCENARIOS: Scenario[] = [duplicate, outOfOrder, missedWebhook, tamper, renewalFailure];
export { stopListener };
