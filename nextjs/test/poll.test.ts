import { describe, expect, it } from "vitest";
import { pollDelays } from "@/lib/poll";

describe("pollDelays", () => {
  it("backs off then plateaus", () => {
    expect(pollDelays().slice(0, 5)).toEqual([1000, 2000, 3000, 5000, 5000]);
  });
  it("is bounded: covers the window but does not run forever", () => {
    const sum = pollDelays().reduce((a, b) => a + b, 0);
    expect(sum).toBeGreaterThanOrEqual(30_000);
    expect(sum).toBeLessThan(40_000);
  });
});
