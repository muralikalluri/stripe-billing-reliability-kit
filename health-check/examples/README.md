# Example apps for the health check

Deliberately broken, minimal Stripe integrations in the style the health check is meant to catch. They are not runnable apps and must not be deployed. `npm test` scans each one and checks the findings; the generated reports are in this folder.

| App | What is wrong with it | Report |
|---|---|---|
| `express-app/` | Verifies a re-serialised body, no duplicate protection, grants access from the success redirect, ignores cancellations and failed renewals | [report-express-app.md](report-express-app.md) |
| `nextjs-app/` | Edge runtime with sync verification, reads `req.json()`, trusts event order, no duplicate protection | [report-nextjs-app.md](report-nextjs-app.md) |
| `no-verification/` | Never checks the Stripe signature at all | [report-no-verification.md](report-no-verification.md) |
