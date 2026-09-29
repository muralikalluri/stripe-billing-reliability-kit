import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { desc, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { getDb, getPool } from "@/db/client";
import { reconcileRuns, webhookEvents } from "@/db/schema";
import { isAdmin } from "@/lib/admin";
import { enqueueEvent, getBoss, RECONCILE_QUEUE } from "@/lib/queue";
import { retryFailedEvent } from "@/lib/retry-event";
import { getStripe } from "@/lib/stripe";
import type { ReconcileReport } from "@/reconcile/reconcile";

export const dynamic = "force-dynamic";

// Every render AND every action re-checks admin server-side; non-admins get a 404.
async function requireAdmin() {
  const session = await auth();
  if (!isAdmin(session?.user?.email)) notFound();
}

async function retryAction(fd: FormData) {
  "use server";
  await requireAdmin();
  await retryFailedEvent(getPool(), getStripe(), enqueueEvent, String(fd.get("eventId")));
  revalidatePath("/admin/events");
}

async function reconcileNowAction() {
  "use server";
  await requireAdmin();
  const boss = await getBoss();
  // singletonKey + short window: repeated clicks queue one run; the run itself also takes a DB lock.
  await boss.send(RECONCILE_QUEUE, { trigger: "manual" }, { singletonKey: "reconcile-manual", singletonSeconds: 60 });
  revalidatePath("/admin/events");
}

const STATUSES = ["received", "processing", "processed", "failed"] as const;

export default async function AdminEventsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  await requireAdmin();
  const { status } = await searchParams;
  const db = getDb();
  const filter = STATUSES.find((s) => s === status);
  const events = await db.select().from(webhookEvents).where(filter ? eq(webhookEvents.status, filter) : undefined).orderBy(desc(webhookEvents.receivedAt)).limit(200);
  const runs = await db.select().from(reconcileRuns).orderBy(desc(reconcileRuns.finishedAt)).limit(10);
  const latest = runs[0]?.report as ReconcileReport | undefined;

  return (
    <main style={{ maxWidth: 1000 }}>
      <h1>Webhook events</h1>
      <p>
        Filter: <a href="/admin/events">all</a>
        {STATUSES.map((s) => <span key={s}> · <a href={`/admin/events?status=${s}`}>{s}</a></span>)}
      </p>
      <table cellPadding={6} style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead><tr><th align="left">event</th><th align="left">type</th><th>status</th><th>attempts</th><th align="left">error</th><th /></tr></thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.eventId} style={{ borderTop: "1px solid #ddd" }}>
              <td><code>{e.eventId}</code></td>
              <td>{e.type}</td>
              <td align="center">{e.status}</td>
              <td align="center">{e.attempts}</td>
              <td>{e.error}</td>
              <td>{e.status === "failed" && (
                <form action={retryAction}><input type="hidden" name="eventId" value={e.eventId} /><button>Retry</button></form>
              )}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Reconciliation</h2>
      <form action={reconcileNowAction}><button>Run reconcile now</button></form>
      {latest ? (
        <>
          <p>
            Latest: {latest.trigger} run finished {latest.finishedAt}; scanned {latest.scanned}, in sync {latest.counts.inSync}, repaired {latest.counts.repaired},
            failed {latest.counts.failed}, skipped {latest.counts.skipped}, reported {latest.counts.reported}.
            {!latest.complete && " (listing incomplete: orphan check skipped)"}
            {latest.circuitBreakerTripped && " (circuit breaker tripped: report only)"}
          </p>
          <pre style={{ background: "#f6f6f6", padding: "1rem", overflow: "auto" }}>{JSON.stringify(latest.drift, null, 2)}</pre>
        </>
      ) : <p>No runs yet.</p>}
    </main>
  );
}
