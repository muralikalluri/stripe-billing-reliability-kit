import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";

const HANDLED_EVENTS =
  "checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,customer.subscription.trial_will_end,invoice.paid,invoice.payment_failed";
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

function waitFor(proc: ChildProcess, pattern: RegExp, label: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
    const onData = (d: Buffer) => {
      out += d.toString();
      if (pattern.test(out)) {
        clearTimeout(timer);
        resolve(out);
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.once("exit", (code) => reject(new Error(`${label} exited early (code ${code})`)));
  });
}

/**
 * Starts the pieces the app needs beside the web server: the queue worker and a `stripe listen` forwarder.
 * Refuses to run against anything but a Stripe TEST key and a local database, and refuses if the listener's
 * signing secret differs from STRIPE_WEBHOOK_SECRET (hashes are compared, secrets are never printed).
 */
export default async function globalSetup() {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  if (!/^(sk|rk)_test_/.test(key) || key.includes("REPLACE_ME")) throw new Error("STRIPE_SECRET_KEY must be a Stripe TEST key (load .env first: see e2e/README.md)");
  const host = new URL(process.env.DATABASE_URL ?? "postgres://none").hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error(`DATABASE_URL host must be local, got "${host}"`);
  const secret = process.env.STRIPE_WEBHOOK_SECRET ?? "";
  if (!secret.startsWith("whsec_")) throw new Error("STRIPE_WEBHOOK_SECRET is not set");

  const worker = spawn("npm", ["run", "--silent", "worker"], { env: { ...process.env, DISABLE_SCHEDULE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  await waitFor(worker, /worker listening/, "the queue worker", 60_000);

  const listener = spawn("stripe", ["listen", "--events", HANDLED_EVENTS, "--forward-to", "http://localhost:3100/api/webhooks/stripe"], {
    env: { ...process.env, STRIPE_API_KEY: key }, // key via env, never argv
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = await waitFor(listener, /Ready!/, "stripe listen", 45_000).catch((e) => {
    worker.kill("SIGTERM");
    throw e;
  });
  const listenSecret = /whsec_[A-Za-z0-9]+/.exec(out)?.[0];
  if (!listenSecret || hash(listenSecret) !== hash(secret)) {
    listener.kill("SIGTERM");
    worker.kill("SIGTERM");
    throw new Error("the listener's signing secret differs from STRIPE_WEBHOOK_SECRET; refusing to run");
  }

  return async () => {
    listener.kill("SIGTERM");
    worker.kill("SIGTERM");
  };
}
