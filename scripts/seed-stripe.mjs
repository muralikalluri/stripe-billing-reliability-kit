#!/usr/bin/env node
// Creates PageMint test-mode products/prices. Idempotent. TEST keys only.
import Stripe from "stripe";
import { assertTestKey, seed } from "./lib/seed.mjs";

const key = process.env.STRIPE_SECRET_KEY;
assertTestKey(key);

const stripe = new Stripe(key);
const ids = await seed(stripe, undefined, (m) => console.error(m));

console.error("\nAdd these to your .env:");
for (const [k, v] of Object.entries(ids)) console.log(`${k}=${v}`);
