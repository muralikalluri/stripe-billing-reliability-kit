import test from "node:test";
import assert from "node:assert/strict";
import { assertTestKey, seed } from "../lib/seed.mjs";
import { CATALOG } from "../lib/catalog.mjs";

// Minimal in-memory fake of the Stripe surface the seed script uses.
function fakeStripe() {
  const prices = [];
  const products = [];
  let n = 0;
  return {
    prices: {
      list: async ({ lookup_keys }) => ({ data: prices.filter((p) => lookup_keys.includes(p.lookup_key)) }),
      create: async (args) => { const p = { id: `price_fake${++n}`, ...args }; prices.push(p); return p; },
    },
    products: {
      retrieve: async (id) => {
        const p = products.find((x) => x.id === id);
        if (!p) throw Object.assign(new Error("No such product"), { code: "resource_missing" });
        return p;
      },
      create: async (args) => { products.push(args); return args; },
    },
    _state: { prices, products },
  };
}

test("assertTestKey rejects live, placeholder and missing keys", () => {
  assert.throws(() => assertTestKey(undefined));
  assert.throws(() => assertTestKey("sk_live_abc"));
  assert.throws(() => assertTestKey("sk_test_REPLACE_ME"));
  assert.doesNotThrow(() => assertTestKey("sk_test_abc123"));
});

test("seed creates every catalog price and maps env names", async () => {
  const s = fakeStripe();
  const ids = await seed(s);
  const expected = CATALOG.flatMap((c) => c.prices.map((p) => p.env));
  assert.deepEqual(Object.keys(ids).sort(), expected.sort());
  assert.equal(s._state.products.length, CATALOG.length);
});

test("seed recovers when a product exists but its prices are missing", async () => {
  const s = fakeStripe();
  await seed(s);
  s._state.prices.length = 0; // simulate crash after product creation
  const ids = await seed(s);
  assert.equal(Object.keys(ids).length, CATALOG.flatMap((c) => c.prices).length);
  assert.equal(s._state.products.length, CATALOG.length);
});

test("seed is idempotent: second run creates nothing new", async () => {
  const s = fakeStripe();
  const first = await seed(s);
  const second = await seed(s);
  assert.deepEqual(second, first);
  assert.equal(s._state.prices.length, CATALOG.flatMap((c) => c.prices).length);
  assert.equal(s._state.products.length, CATALOG.length);
});
