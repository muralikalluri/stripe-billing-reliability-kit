// Server-side allowlist: clients send a plan key, never a raw price id.
export type PlanKey = "pro_monthly" | "pro_yearly" | "team_seat";
export type PlanName = "pro" | "team";

export const TRIAL_DAYS_PRO = 14;

export function priceIds(e: Record<string, string | undefined> = process.env): Record<PlanKey, string | undefined> {
  return {
    pro_monthly: e.STRIPE_PRICE_PRO_MONTHLY,
    pro_yearly: e.STRIPE_PRICE_PRO_YEARLY,
    team_seat: e.STRIPE_PRICE_TEAM_SEAT,
  };
}

export function planKeyFromString(v: unknown): PlanKey | null {
  return v === "pro_monthly" || v === "pro_yearly" || v === "team_seat" ? v : null;
}

export function planNameForPrice(priceId: string, ids = priceIds()): PlanName | null {
  if (priceId === ids.pro_monthly || priceId === ids.pro_yearly) return "pro";
  if (priceId === ids.team_seat) return "team";
  return null;
}
