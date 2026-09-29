import { auth } from "@/auth";
import { getDb } from "@/db/client";
import { BillingError, createPortalUrl } from "@/lib/billing";
import { env } from "@/lib/env";
import { getStripe } from "@/lib/stripe";

export const runtime = "nodejs";

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthenticated" }, { status: 401 });
  try {
    return Response.redirect(await createPortalUrl(getDb(), getStripe(), session.user.id, env.appUrl), 303);
  } catch (e) {
    if (e instanceof BillingError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
