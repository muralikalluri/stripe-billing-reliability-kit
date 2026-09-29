# The same pattern on Firebase (Cloud Functions + Firestore)

> **Pattern sketch, not executed in this repository.** The reference implementations use Postgres. Firestore has no cross-document `ON CONFLICT` or advisory locks, so the guarantees are achieved differently. Test with the Stripe CLI and point the chaos scenarios at the function only after adapting their database access (they read the SQL tables).

## Mapping the rules

| Rule | On Firebase |
|---|---|
| Raw body, verify before parsing | `req.rawBody` (Buffer) in an `onRequest` function, then `stripe.webhooks.constructEvent(rawBody, sig, secret)` |
| Idempotent on `event.id` | `docRef('webhook_events/{event.id}').create(...)`: `create()` fails with `ALREADY_EXISTS` if the document exists, which is your atomic dedupe |
| Fast 200, process in a job | enqueue a Cloud Task (or write a `jobs/{event.id}` doc and trigger `onDocumentCreated`); return 200 |
| Order / concurrency safety | do the sync in a Firestore **transaction**: read the subscription doc, compare `updated_from_event_created`, write only if not older |
| Access reads `entitlements` only | Security rules: users may read their own `entitlements/{uid}`; clients can never write it |
| Repair missed events | a scheduled function (`onSchedule("every day 03:00")`) that runs reconcile |

## Webhook function
```ts
import { onRequest } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);              // TEST key until sign-off

export const stripeWebhook = onRequest({ secrets: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] }, async (req, res) => {
  const sig = req.headers["stripe-signature"];
  if (typeof sig !== "string") { res.status(400).send("missing signature"); return; }
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET!);  // rawBody, not req.body
  } catch { res.status(400).send("invalid signature"); return; }

  const db = getFirestore();
  try {
    // One batch: the event record and the job commit together or not at all.
    const batch = db.batch();
    batch.create(db.doc(`webhook_events/${event.id}`), { type: event.type, status: "received", attempts: 0, receivedAt: new Date() });
    batch.create(db.doc(`jobs/${event.id}`), { event, runAfter: new Date() });
    await batch.commit();
  } catch (e: any) {
    if (e.code === 6 /* ALREADY_EXISTS */) { res.json({ received: true, duplicate: true }); return; }
    res.status(500).send("enqueue failed"); return;                     // Stripe retries; nothing was written
  }
  res.json({ received: true, duplicate: false });
});
```

## Sync (the part that differs most)
```ts
await db.runTransaction(async (tx) => {
  const sub = await stripe.subscriptions.retrieve(subId);               // latest state, never the event payload
  const ref = db.doc(`subscriptions/${sub.id}`);
  const cur = await tx.get(ref);
  if (cur.exists && cur.data()!.updatedFromEventCreated > event.created) return;   // stale: ignore
  tx.set(ref, { ...mapSubscription(sub), userId, updatedFromEventCreated: event.created }, { merge: true });
  // recompute entitlement from ALL of this user's subscriptions with the shared deriveEntitlement
  // (query them inside the transaction so two subscriptions of one user cannot race).
});
```
Firestore transactions retry on contention, which replaces the advisory locks used in Postgres. Keep `deriveEntitlement` in one module and port the policy from [state-machine.md](state-machine.md) unchanged. Never take the user id from the request; map `stripe_customer_id` to `userId` from your own `customers` collection and fail on unknown customers.

## Security rules
```
match /entitlements/{uid} { allow read: if request.auth.uid == uid; allow write: if false; }
match /{document=**} { allow read, write: if false; }   // webhook_events, jobs, subscriptions: Admin SDK only
```

## Watch out for
- `req.body` is already parsed by the functions framework; using it for verification fails. Use `req.rawBody`.
- 1 write/second sustained on a single document is Firestore's soft limit; per-subscription documents are fine, a global counter document is not.
- Cloud Functions may run an invocation twice; the `create()` guard and idempotent sync cover this.
- Test-clock subscriptions are hidden from the global Stripe list: list per known customer in reconcile.
