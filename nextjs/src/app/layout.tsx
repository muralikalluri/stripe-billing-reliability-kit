import type { ReactNode } from "react";

export const metadata = { title: "PageMint", description: "Fictional demo SaaS for stripe-billing-reliability-kit" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui", maxWidth: 760, margin: "2rem auto", padding: "0 1rem" }}>
        <nav style={{ display: "flex", gap: "1rem", marginBottom: "2rem" }}>
          <a href="/pricing">Pricing</a>
          <a href="/account">Account</a>
        </nav>
        {children}
      </body>
    </html>
  );
}
