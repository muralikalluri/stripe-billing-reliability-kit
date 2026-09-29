import { auth } from "@/auth";
import { getDb } from "@/db/client";
import { getEntitlement } from "@/lib/entitlements/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Session only: no user id or session_id from the request. Reads the entitlements table only.
export async function GET() {
  const session = await auth();
  const headers = { "Cache-Control": "no-store" };
  if (!session?.user?.id) return Response.json({ error: "unauthenticated" }, { status: 401, headers });
  const ent = await getEntitlement(getDb(), session.user.id);
  return Response.json(ent ? { access: true, plan: ent.plan } : { access: false }, { headers });
}
