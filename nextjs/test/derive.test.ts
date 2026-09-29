import { describe, expect, it } from "vitest";
import {
  ACCESS_POLICY,
  bestEntitlement,
  deriveEntitlement,
  PAST_DUE_GRACE_MS,
  RENEWAL_BUFFER_MS,
  type SubscriptionState,
} from "@/lib/entitlements/derive";

const start = new Date("2030-01-01T00:00:00Z");
const end = new Date("2030-02-01T00:00:00Z");
const sub = (over: Partial<SubscriptionState> = {}): SubscriptionState => ({
  status: "active",
  plan: "pro",
  quantity: 1,
  currentPeriodStart: start,
  currentPeriodEnd: end,
  cancelAtPeriodEnd: false,
  ...over,
});

describe("deriveEntitlement: every Stripe status", () => {
  it("active: plan until period end + renewal buffer", () => {
    const e = deriveEntitlement(sub({ status: "active" }));
    expect(e.plan).toBe("pro");
    expect(e.validUntil!.getTime()).toBe(end.getTime() + RENEWAL_BUFFER_MS);
  });

  it("trialing: plan until period end + renewal buffer", () => {
    const e = deriveEntitlement(sub({ status: "trialing" }));
    expect(e.plan).toBe("pro");
    expect(e.validUntil!.getTime()).toBe(end.getTime() + RENEWAL_BUFFER_MS);
  });

  it("past_due: plan until the FAILED period's start + grace (not the advanced period end)", () => {
    const e = deriveEntitlement(sub({ status: "past_due" }));
    expect(e.plan).toBe("pro");
    expect(e.validUntil!.getTime()).toBe(start.getTime() + PAST_DUE_GRACE_MS);
    expect(e.validUntil!.getTime()).toBeLessThan(end.getTime());
  });

  it.each(["incomplete", "incomplete_expired", "unpaid", "canceled", "paused"])("%s: no access", (status) => {
    expect(deriveEntitlement(sub({ status })).plan).toBe("free");
  });

  it("an unknown/future status fails closed", () => {
    expect(deriveEntitlement(sub({ status: "something_new" })).plan).toBe("free");
  });

  it("policy table documents exactly the statuses handled", () => {
    expect(Object.keys(ACCESS_POLICY).sort()).toEqual(
      ["active", "canceled", "incomplete", "incomplete_expired", "past_due", "paused", "trialing", "unpaid"],
    );
  });
});

describe("deriveEntitlement: edge cases", () => {
  it("cancel_at_period_end removes the renewal buffer", () => {
    expect(deriveEntitlement(sub({ cancelAtPeriodEnd: true })).validUntil!.getTime()).toBe(end.getTime());
  });
  it("no subscription, or an unknown plan, is free", () => {
    expect(deriveEntitlement(null).plan).toBe("free");
    expect(deriveEntitlement(sub({ plan: null })).plan).toBe("free");
  });
  it("missing dates fail closed", () => {
    expect(deriveEntitlement(sub({ currentPeriodEnd: null })).plan).toBe("free");
    expect(deriveEntitlement(sub({ status: "past_due", currentPeriodStart: null })).plan).toBe("free");
  });
  it("invariant: a paid plan never has a null validUntil", () => {
    for (const status of ["active", "trialing", "past_due", "canceled", "unpaid", "paused", "incomplete", "x"]) {
      for (const cancelAtPeriodEnd of [true, false]) {
        const e = deriveEntitlement(sub({ status, cancelAtPeriodEnd }));
        if (e.plan !== "free") expect(e.validUntil).not.toBeNull();
      }
    }
  });
  it("seats follow quantity, minimum 1", () => {
    expect(deriveEntitlement(sub({ plan: "team", quantity: 5 })).seats).toBe(5);
    expect(deriveEntitlement(sub({ quantity: 0 })).seats).toBe(1);
  });
});

describe("bestEntitlement (several subscriptions)", () => {
  const ent = (plan: "pro" | "team" | "free", until?: string) => ({ plan, seats: 1, validUntil: until ? new Date(until) : null });
  it("active beats canceled", () => {
    expect(bestEntitlement([ent("free"), ent("pro", "2030-01-01")]).plan).toBe("pro");
  });
  it("higher plan wins, then later validUntil", () => {
    expect(bestEntitlement([ent("pro", "2031-01-01"), ent("team", "2030-01-01")]).plan).toBe("team");
    expect(bestEntitlement([ent("pro", "2030-01-01"), ent("pro", "2031-01-01")]).validUntil).toEqual(new Date("2031-01-01"));
  });
  it("empty is free", () => {
    expect(bestEntitlement([]).plan).toBe("free");
  });
});
