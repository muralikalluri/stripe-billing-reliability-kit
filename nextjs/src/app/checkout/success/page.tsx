import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { Poller } from "./Poller";

export const dynamic = "force-dynamic";

// The redirect from Stripe proves nothing. This page reads nothing from the URL and grants nothing;
// it polls /api/me/entitlement, which reports what the webhook worker wrote to entitlements.
export default async function SuccessPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  return (
    <main>
      <h1>Thanks!</h1>
      <Poller />
      <a href="/account">Go to account</a>
    </main>
  );
}
