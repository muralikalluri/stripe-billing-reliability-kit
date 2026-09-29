function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export const env = {
  get stripeSecretKey() {
    const k = required("STRIPE_SECRET_KEY");
    if (!/^(sk|rk)_test_/.test(k)) throw new Error("STRIPE_SECRET_KEY must be a Stripe TEST mode key");
    return k;
  },
  get webhookSecret() {
    return required("STRIPE_WEBHOOK_SECRET");
  },
  get appUrl() {
    return process.env.APP_URL ?? "http://localhost:3000";
  },
};
