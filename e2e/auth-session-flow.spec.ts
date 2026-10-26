/**
 * CashPilot AI — Authentication & Session-Aware App Shell E2E Tests (Phase 2D.2)
 *
 * Verifies end-to-end in the browser:
 * 1. Safe target database identity check (must be cashpilot_disposable_test)
 * 2. Unauthenticated visitors are redirected to /login from protected routes
 * 3. Judge Demo Access entry point ("Explore Demo Workspace") securely logs in to demo-workspace-1
 * 4. Demo workspace visibly displays DEMO WORKSPACE and PayPal Sandbox indicators
 * 5. Signup flow creates a new user with an empty, non-demo workspace
 * 6. Login and Logout lifecycle
 * 7. Cross-workspace isolation: user cannot access demo invoices by ID tampering
 * 8. Cleanup only deletes records created during the test run
 */

import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const DISPOSABLE_DB_URL =
  process.env.TEST_DATABASE_URL ||
  (process.env.DATABASE_URL || "").replace(/\/cashpilot_dev(\?.*)?$/, "/cashpilot_disposable_test$1") ||
  "postgresql://cashpilot:cashpilot_dev_password@localhost:5433/cashpilot_disposable_test?schema=public";

test.describe.configure({ mode: "serial" });

test.describe("Phase 2D.2: Authentication & Judge Demo Access E2E", () => {
  let prisma: PrismaClient;
  const testRunTimestamp = Date.now();
  const testUserEmail = `e2e-user-${testRunTimestamp}@example.com`;
  const testUserName = "E2E Judge Tester";
  const testBusinessName = `Apex Media Lab ${testRunTimestamp}`;
  const testPassword = "Password123!@#";

  let createdUserId: string | null = null;
  let createdWorkspaceId: string | null = null;

  test.beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: DISPOSABLE_DB_URL } },
    });

    // 1. NON-NEGOTIABLE SAFETY CHECK: Verify database identity
    const dbCheck = await prisma.$queryRaw<Array<{ current_database: string }>>`
      SELECT current_database();
    `;
    const currentDb = dbCheck[0]?.current_database;
    if (currentDb !== "cashpilot_disposable_test") {
      throw new Error(
        `SAFETY VIOLATION: E2E tests must run exclusively on "cashpilot_disposable_test", but connected to "${currentDb}". Aborting.`
      );
    }
  });

  test.afterAll(async () => {
    // Clean up ONLY records created during this test run
    if (createdWorkspaceId) {
      await prisma.invoiceLineItem.deleteMany({
        where: { invoice: { workspaceId: createdWorkspaceId } },
      }).catch(() => {});
      await prisma.invoice.deleteMany({
        where: { workspaceId: createdWorkspaceId },
      }).catch(() => {});
      await prisma.client.deleteMany({
        where: { workspaceId: createdWorkspaceId },
      }).catch(() => {});
      await prisma.workspace.deleteMany({
        where: { id: createdWorkspaceId },
      }).catch(() => {});
    }

    if (createdUserId) {
      await prisma.session.deleteMany({
        where: { userId: createdUserId },
      }).catch(() => {});
      await prisma.user.deleteMany({
        where: { id: createdUserId },
      }).catch(() => {});
    }

    await prisma.$disconnect();
  });

  test("1. Unauthenticated visitors are redirected to /login from all protected pages", async ({ page }) => {
    // Clear cookies to guarantee unauthenticated state
    await page.context().clearCookies();

    const protectedPaths = ["/", "/invoices", "/collections", "/invoices/new", "/navi-ai"];

    for (const path of protectedPaths) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login/);
      await expect(page.locator("h1")).toContainText(/Welcome back|Sign in/i);
    }
  });

  test("2. Judge Demo Access entry point reaches the pre-seeded demo workspace with visible labels", async ({ page, isMobile }) => {
    await page.context().clearCookies();
    await page.goto("/login");

    // Check for Explore Demo Workspace button
    const demoBtn = page.locator("#explore-demo-workspace-btn");
    await expect(demoBtn).toBeVisible();
    await expect(demoBtn).toContainText("Explore Demo Workspace");

    // Click to enter demo
    await demoBtn.click();

    // Must navigate to Dashboard
    await expect(page).toHaveURL(/localhost:3000\/?$/);

    // Verify AppHeader demo indicators
    const banner = page.locator("header");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("My Freelance Studio");
    await expect(banner).toContainText("DEMO WORKSPACE");
    await expect(banner).toContainText("PayPal Sandbox");
    await expect(banner).toContainText("No real money moves");

    // Verify demo user profile badge
    await expect(banner).toContainText("Demo User");
    await expect(banner).toContainText("demo@cashpilot.test");

    // Verify seeded demo metrics exist
    const metricsSection = page.locator("section[aria-label='Receivables Metrics']");
    await expect(metricsSection).toBeVisible();
    await expect(metricsSection).toContainText("Outstanding");
    await expect(metricsSection).toContainText("Overdue");

    // Navigate to Collections and check Kanban board
    await page.goto("/collections");
    await expect(page).toHaveURL(/\/collections/);
    await expect(page.locator("h1")).toContainText("Collections Workspace");

    // Sign out to leave demo workspace
    await page.goto("/");
    await expect(page.getByRole("banner").first()).toContainText("Demo User");
    if (isMobile) {
      await page.locator("button[aria-label='Open navigation menu']").first().click();
      await page.locator("#mobile-sign-out-btn").click();
    } else {
      await page.locator("#desktop-sign-out-btn").first().click();
    }

    // Must return to /login
    await expect(page).toHaveURL(/\/login/);
  });

  test("3. Signup creates a new account with an isolated, empty, non-demo workspace", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/signup");

    await expect(page.locator("h1")).toContainText("Create your account");

    // Fill registration form
    await page.fill("#name", testUserName);
    await page.fill("#email", testUserEmail);
    await page.fill("#businessName", testBusinessName);
    await page.fill("#password", testPassword);

    await page.click("button[type='submit']");

    // Redirected to Dashboard on success
    await expect(page).toHaveURL(/localhost:3000\/?$/);

    // Verify custom business name appears in AppHeader
    const header = page.locator("header");
    await expect(header).toContainText(testBusinessName);
    await expect(header).toContainText(testUserName);

    // Non-demo workspace must NOT have the DEMO WORKSPACE badge
    await expect(header).not.toContainText("DEMO WORKSPACE");

    // Check receivables metrics are $0.00 / 0
    const metricsSection = page.locator("section[aria-label='Receivables Metrics']");
    await expect(metricsSection).toBeVisible();
    await expect(metricsSection).toContainText("$0.00");

    // Invoices list must have 0 invoices
    await page.goto("/invoices");
    await expect(page).toHaveURL(/\/invoices/);
    await expect(page.getByText("No invoices matched your filter criteria", { exact: false })).toBeVisible();

    // Fetch user and workspace IDs from database for subsequent tests and cleanup
    const userRecord = await prisma.user.findUnique({
      where: { email: testUserEmail },
      include: { workspaces: true },
    });
    expect(userRecord).not.toBeNull();
    createdUserId = userRecord!.id;
    createdWorkspaceId = userRecord!.workspaces[0]?.id ?? null;
    expect(createdWorkspaceId).not.toBeNull();
    expect(userRecord!.workspaces[0]?.isDemo).toBe(false);
  });

  test("4. Login and Logout lifecycle works for the newly registered user", async ({ page, isMobile }) => {
    // 1. Visit /login
    await page.goto("/login");

    // 2. Invalid password rejected
    await page.fill("#email", testUserEmail);
    await page.fill("#password", "WrongPassword123!");
    await page.click("button[type='submit']");
    const errorAlert = page.getByRole("alert").filter({ hasText: "Invalid email or password" });
    await expect(errorAlert).toBeVisible();

    // 3. Valid credentials succeed
    await page.fill("#password", testPassword);
    await page.click("button[type='submit']");
    await expect(page).toHaveURL(/localhost:3000\/?$/);
    await expect(page.locator("header")).toContainText(testUserName);

    // 4. Sign out
    if (isMobile) {
      await page.locator("button[aria-label='Open navigation menu']").first().click();
      await page.locator("#mobile-sign-out-btn").click();
    } else {
      await page.locator("#desktop-sign-out-btn").click();
    }
    await expect(page).toHaveURL(/\/login/);

    // 5. Verify unauthenticated redirect after logout
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
  });

  test("5. Cross-workspace isolation: authenticated user cannot access demo invoices by ID tampering", async ({ page }) => {
    // 1. Log in as regular user
    await page.goto("/login");
    await page.fill("#email", testUserEmail);
    await page.fill("#password", testPassword);
    await page.click("button[type='submit']");
    await expect(page).toHaveURL(/localhost:3000\/?$/);

    // 2. Attempt to access demo invoice by ID directly
    await page.goto("/invoices/demo-inv-1");

    // 3. Must return 404 Not Found (not the demo invoice data)
    await expect(page.getByText("404", { exact: false })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("UX Design Services — Q4 2026");
  });

  test("6. Seeded demo data remains intact and isolated", async () => {
    // Re-verify that demo invoices in demo-workspace-1 exist and were not altered
    const demoInvoices = await prisma.invoice.findMany({
      where: { workspaceId: "demo-workspace-1" },
    });
    expect(demoInvoices.length).toBeGreaterThan(0);

    const demoClients = await prisma.client.findMany({
      where: { workspaceId: "demo-workspace-1" },
    });
    expect(demoClients.length).toBeGreaterThan(0);
  });
});
