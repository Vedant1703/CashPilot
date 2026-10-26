import { defineConfig, devices } from "@playwright/test";

const PERMITTED_TEST_DATABASE = "cashpilot_disposable_test";

const rawTestDbUrl =
  process.env.TEST_DATABASE_URL ||
  "postgresql://cashpilot:cashpilot_dev_password@127.0.0.1:5433/cashpilot_disposable_test?schema=public";

let parsed: URL;
try {
  parsed = new URL(rawTestDbUrl);
} catch {
  throw new Error("SAFETY VIOLATION: Malformed TEST_DATABASE_URL configured for Playwright E2E runs.");
}

if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
  throw new Error("SAFETY VIOLATION: TEST_DATABASE_URL must use 'postgresql:' or 'postgres:' scheme.");
}

const configuredDbName = parsed.pathname.replace(/^\//, "").split("?")[0];

if (!configuredDbName) {
  throw new Error("SAFETY VIOLATION: TEST_DATABASE_URL does not specify a database name.");
}

if (configuredDbName !== PERMITTED_TEST_DATABASE) {
  throw new Error(
    `SAFETY VIOLATION: Playwright test suite must target "${PERMITTED_TEST_DATABASE}", but configured database is "${configuredDbName}".`
  );
}

const testDbUrl = rawTestDbUrl;

/**
 * Playwright E2E Configuration for CashPilot AI
 *
 * Tests critical browser journeys for invoice drafting, approval modals,
 * status synchronization, reminders, and cancellations.
 *
 * External provider (PayPal) operations are strictly mocked at the API route level
 * using Playwright's `page.route` to prevent live or sandbox writes during E2E testing.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"]],
  timeout: 45000,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000",
    extraHTTPHeaders: {
      "x-workspace-id": "demo-workspace-1",
      "x-actor-id": "demo-user-1",
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop-chrome",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 720 },
      },
    },
    {
      name: "mobile-chrome",
      use: {
        ...devices["Pixel 5"],
        viewport: { width: 393, height: 851 },
      },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 60000,
    env: {
      DATABASE_URL: testDbUrl,
    },
  },
});
