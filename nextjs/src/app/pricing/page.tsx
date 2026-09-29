import { auth } from "@/auth";

const PLANS = [
  { key: null, name: "Free", price: "$0", note: "Basic pages" },
  { key: "pro_monthly", name: "Pro monthly", price: "$12 / mo", note: "14-day trial" },
  { key: "pro_yearly", name: "Pro yearly", price: "$120 / yr", note: "14-day trial" },
  { key: "team_seat", name: "Team", price: "$9 / seat / mo", note: "Per seat" },
] as const;

export default async function PricingPage() {
  const session = await auth();
  return (
    <main>
      <h1>PageMint pricing</h1>
      {!session && <p><a href="/login">Sign in</a> to subscribe.</p>}
      <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: "1rem" }}>
        {PLANS.map((p) => (
          <li key={p.name} style={{ border: "1px solid #ccc", padding: "1rem" }}>
            <strong>{p.name}</strong> — {p.price} <small>({p.note})</small>
            {p.key && session && (
              <form action="/api/checkout" method="post" style={{ marginTop: ".5rem" }}>
                <input type="hidden" name="plan" value={p.key} />
                <button type="submit">Subscribe</button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
