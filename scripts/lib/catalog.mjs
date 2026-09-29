// Fictional "PageMint" catalog. Free has no Stripe object (no payment needed).
// lookup_key makes the seed script idempotent and lets apps resolve prices by key.
export const CATALOG = [
  {
    key: "pagemint_pro",
    name: "PageMint Pro",
    prices: [
      { lookup_key: "pro_monthly", unit_amount: 1200, interval: "month", env: "STRIPE_PRICE_PRO_MONTHLY" },
      { lookup_key: "pro_yearly", unit_amount: 12000, interval: "year", env: "STRIPE_PRICE_PRO_YEARLY" },
    ],
  },
  {
    key: "pagemint_team",
    name: "PageMint Team (per seat)",
    prices: [
      { lookup_key: "team_seat_monthly", unit_amount: 900, interval: "month", env: "STRIPE_PRICE_TEAM_SEAT" },
    ],
  },
];

export const TRIAL_DAYS_PRO = 14;
