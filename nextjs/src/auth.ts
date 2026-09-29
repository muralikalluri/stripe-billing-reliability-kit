import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";

// Deliberately insecure for demonstration. Do not deploy.
// DEMO AUTH: email-only sign-in with no verification, so anyone can sign in as ANY email, including an
// ADMIN_EMAILS address. It is OFF unless DEMO_AUTH=1 and never on in production. Add a real provider
// (Auth.js email magic link, OAuth, ...) before any real use; the billing code only needs session.user.id/email.
export const demoAuthEnabled = process.env.DEMO_AUTH === "1" && process.env.NODE_ENV !== "production";

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: demoAuthEnabled ? [
    Credentials({
      credentials: { email: { label: "Email", type: "email" } },
      async authorize(creds) {
        const email = String(creds?.email ?? "").trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
        const db = getDb();
        await db.insert(users).values({ id: randomUUID(), email }).onConflictDoNothing();
        const [u] = await db.select().from(users).where(eq(users.email, email));
        return { id: u.id, email: u.email };
      },
    }),
  ] : [],
  callbacks: {
    jwt({ token, user }) {
      if (user?.id) token.uid = user.id;
      return token;
    },
    session({ session, token }) {
      if (token.uid) session.user.id = token.uid as string;
      return session;
    },
  },
});
