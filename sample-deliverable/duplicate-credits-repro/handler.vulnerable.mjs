// Deliberately insecure for demonstration. Do not deploy.
// The flaw (seeded on purpose): credits are granted on EVERY delivery of invoice.paid.
// Stripe delivers events at least once, so retries and replays double-credit the customer,
// and the read-modify-write on the balance also loses updates under concurrency.
export const CREDITS_PER_INVOICE = 500;

export async function handleInvoicePaid(pool, schema, event) {
  const invoice = event.data.object;
  const { rows } = await pool.query(`select id, balance from ${schema}.accounts where stripe_customer_id = $1`, [invoice.customer]);
  if (!rows[0]) throw new Error("unknown customer");
  const account = rows[0];
  await pool.query(`update ${schema}.accounts set balance = $1 where id = $2`, [account.balance + CREDITS_PER_INVOICE, account.id]);
  await pool.query(
    `insert into ${schema}.credit_ledger (account_id, amount, stripe_event_id, stripe_invoice_id) values ($1,$2,$3,$4)`,
    [account.id, CREDITS_PER_INVOICE, event.id, invoice.id],
  );
}
