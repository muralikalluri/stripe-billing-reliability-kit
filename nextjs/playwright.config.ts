import { defineConfig } from "@playwright/test";

// Opt-in LIVE suite: talks to real Stripe test mode. Run with `npm run e2e` (see e2e/README.md).
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 300_000,
  expect: { timeout: 60_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: { baseURL: "http://localhost:3100", trace: "retain-on-failure", screenshot: "only-on-failure" },
  // Dev server on purpose: the insecure demo login is disabled in production builds.
  webServer: {
    command: "npx next dev -p 3100",
    url: "http://localhost:3100/login",
    reuseExistingServer: true,
    timeout: 120_000,
    env: { DEMO_AUTH: "1", APP_URL: "http://localhost:3100" },
  },
});
