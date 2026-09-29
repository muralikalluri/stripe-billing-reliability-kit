import { auth } from "@/auth";
import { getDb } from "@/db/client";
import { BillingError, createCheckoutUrl } from "@/lib/billing";
import { env } from "@/lib/env";
import { getStripe } from "@/lib/stripe";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const form = await req.formData().catch(() => null);
  try {
    const url = await createCheckoutUrl(getDb(), getStripe(), session.user, form?.get("plan"), env.appUrl);
    return Response.redirect(url, 303);
  } catch (e) {
    if (e instanceof BillingError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
