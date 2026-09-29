import { CATALOG } from "./catalog.mjs";

export function assertTestKey(key) {
  if (typeof key !== "string" || !/^(sk|rk)_test_/.test(key) || /REPLACE_ME/.test(key)) {
    throw new Error("Refusing to run: STRIPE_SECRET_KEY must be a real Stripe TEST mode key (sk_test_... or rk_test_...).");
  }
}

/**
 * Idempotently ensure every catalog product/price exists. Safe to re-run:
 * existing prices are found by lookup_key; products by metadata.catalog_key.
 * `stripe` only needs products.search/create, prices.list/create.
 */
export async function seed(stripe, catalog = CATALOG, log = () => {}) {
  const result = {};
  for (const item of catalog) {
    const existing = await stripe.prices.list({
      lookup_keys: item.prices.map((p) => p.lookup_key),
      active: true,
      limit: 100,
    });
    const byKey = new Map(existing.data.map((p) => [p.lookup_key, p]));

    // Deterministic product id: no dependence on the (eventually consistent) search index.
    let productId = item.key;
    try {
      await stripe.products.retrieve(productId);
    } catch (e) {
      if (e?.code !== "resource_missing") throw e;
      await stripe.products.create({ id: productId, name: item.name, metadata: { catalog_key: item.key } });
      log(`created product ${item.key}`);
    }

    for (const p of item.prices) {
      let price = byKey.get(p.lookup_key);
      if (price) {
        log(`exists  price ${p.lookup_key} (${price.id})`);
      } else {
        price = await stripe.prices.create({
          product: productId,
          currency: "usd",
          unit_amount: p.unit_amount,
          recurring: { interval: p.interval },
          lookup_key: p.lookup_key,
        });
        log(`created price ${p.lookup_key} (${price.id})`);
      }
      result[p.env] = price.id;
    }
  }
  return result;
}
