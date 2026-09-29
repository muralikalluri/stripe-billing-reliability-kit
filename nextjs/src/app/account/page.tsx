import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getDb } from "@/db/client";
import { getEntitlement } from "@/lib/entitlements/access";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const ent = await getEntitlement(getDb(), session.user.id);
  return (
    <main>
      <h1>Account</h1>
      <p>{session.user.email}</p>
      <p>Plan: <strong>{ent ? ent.plan : "free"}</strong>{ent ? ` (${ent.seats} seat${ent.seats > 1 ? "s" : ""})` : ""}</p>
      <form action="/api/portal" method="post">
        <button type="submit">Manage billing</button>
      </form>
    </main>
  );
}
