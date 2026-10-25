// Tiny assertion helpers on node:assert (no registry fetch needed beyond npm).
import nodeAssert from "node:assert/strict";
export const assertEquals = (actual: unknown, expected: unknown, msg?: string) => nodeAssert.deepStrictEqual(actual, expected, msg);
export const assert = (v: unknown, msg?: string) => nodeAssert.ok(v, msg);
export async function assertRejects(fn: () => Promise<unknown>, _cls?: unknown, includes?: string) {
  await nodeAssert.rejects(fn, (e: Error) => (includes ? e.message.includes(includes) : true));
}
