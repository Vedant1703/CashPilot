import { defineConfig, devices } from "@playwright/test";

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
  },
});
