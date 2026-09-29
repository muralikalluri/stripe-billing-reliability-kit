"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { pollDelays } from "@/lib/poll";

type State = { kind: "waiting" } | { kind: "granted"; plan: string } | { kind: "timeout" };

// Polls SERVER state (entitlements table). The redirect itself proves nothing and grants nothing.
export function Poller() {
  const [state, setState] = useState<State>({ kind: "waiting" });
  const run = useRef(0);

  const start = useCallback(async () => {
    const id = ++run.current;
    setState({ kind: "waiting" });
    for (const delay of [0, ...pollDelays()]) {
      await new Promise((r) => setTimeout(r, delay));
      if (run.current !== id) return;
      try {
        const res = await fetch("/api/me/entitlement", { cache: "no-store" });
        const body = await res.json();
        if (body.access) return setState({ kind: "granted", plan: body.plan });
      } catch {
        /* transient: keep polling */
      }
    }
    if (run.current === id) setState({ kind: "timeout" });
  }, []);

  useEffect(() => {
    void start();
    return () => {
      run.current++;
    };
  }, [start]);

  if (state.kind === "granted") return <p>Your <strong>{state.plan}</strong> plan is active.</p>;
  if (state.kind === "timeout") {
    return (
      <p>
        Payment is still being confirmed; this can take a minute. <button onClick={start}>Check again</button> or{" "}
        <a href="/account">view your account</a>.
      </p>
    );
  }
  return <p>Confirming your payment…</p>;
}
