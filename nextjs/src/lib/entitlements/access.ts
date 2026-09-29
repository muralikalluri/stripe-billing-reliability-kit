import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { entitlements } from "@/db/schema";

/** Access checks read the entitlements table only. Fails closed on free, missing or expired validUntil. */
export async function getEntitlement(db: Db, userId: string, now: Date = new Date()) {
  const [row] = await db.select().from(entitlements).where(eq(entitlements.userId, userId));
  if (!row || row.plan === "free") return null;
  if (!row.validUntil || row.validUntil.getTime() <= now.getTime()) return null;
  return row;
}

export async function hasAccess(db: Db, userId: string, now: Date = new Date()): Promise<boolean> {
  return (await getEntitlement(db, userId, now)) !== null;
}
