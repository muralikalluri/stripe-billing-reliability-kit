// The fix: one transaction, idempotent on the invoice (and recorded per event), atomic balance update.
export const CREDITS_PER_INVOICE = 500;

export async function handleInvoicePaid(pool, schema, event) {
  const invoice = event.data.object;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const acct = await client.query(`select id from ${schema}.accounts where stripe_customer_id = $1`, [invoice.customer]);
    if (!acct.rows[0]) throw new Error("unknown customer");
    // The unique index on stripe_invoice_id is the guard: a replay or a second event for the same invoice inserts nothing.
    const ins = await client.query(
      `insert into ${schema}.credit_ledger (account_id, amount, stripe_event_id, stripe_invoice_id)
       values ($1,$2,$3,$4) on conflict (stripe_invoice_id) do nothing returning id`,
      [acct.rows[0].id, CREDITS_PER_INVOICE, event.id, invoice.id],
    );
    if (ins.rowCount === 1) {
      // Atomic increment, not read-modify-write.
      await client.query(`update ${schema}.accounts set balance = balance + $1 where id = $2`, [CREDITS_PER_INVOICE, acct.rows[0].id]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
