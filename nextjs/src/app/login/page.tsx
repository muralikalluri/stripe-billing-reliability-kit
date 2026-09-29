import { demoAuthEnabled, signIn } from "@/auth";

export default function LoginPage() {
  if (!demoAuthEnabled) {
    return (
      <main>
        <h1>Sign in</h1>
        <p>No auth provider is configured. Set <code>DEMO_AUTH=1</code> for local demos (non-production only), or add a real Auth.js provider.</p>
      </main>
    );
  }
  return (
    <main>
      <h1>Sign in</h1>
      <p><strong>Deliberately insecure for demonstration. Do not deploy.</strong> Demo auth: email only, no verification.</p>
      <form
        action={async (fd: FormData) => {
          "use server";
          await signIn("credentials", { email: fd.get("email"), redirectTo: "/pricing" });
        }}
      >
        <input name="email" type="email" placeholder="you@example.com" required />
        <button type="submit">Continue</button>
      </form>
    </main>
  );
}
