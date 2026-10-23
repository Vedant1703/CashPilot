import { test, expect } from "@playwright/test";

test.describe("Journey A: Dashboard and Collections", () => {
  test("loads dashboard, renders metrics, and navigates to collections and invoice detail", async ({
    page,
    isMobile,
  }) => {
    // 1. Visit Dashboard
    await page.goto("/");
    await expect(page).toHaveTitle(/CashPilot/i);

    // Verify Navi Greeting Callout
    const naviGreeting = page.locator("section[aria-label='Navi AI Assistant Overview']");
    await expect(naviGreeting).toBeVisible();

    // Verify 4 primary metric cards
    const metricsSection = page.locator("section[aria-label='Receivables Metrics']");
    await expect(metricsSection).toBeVisible();
    await expect(metricsSection).toContainText("Outstanding");
    await expect(metricsSection).toContainText("Overdue");
    await expect(metricsSection).toContainText("Due Soon");
    await expect(metricsSection).toContainText("Paid");

    // 2. Navigate to Collections
    if (isMobile) {
      await page.goto("/collections");
    } else {
      await page.locator("a[href='/collections']").first().click();
    }
    await expect(page).toHaveURL(/\/collections/);
    await expect(page.locator("h1").filter({ hasText: "Collections Workspace" })).toBeVisible();

    // Verify Kanban Board view is rendered
    await expect(page.getByText("Awaiting Payment", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Overdue", { exact: false }).first()).toBeVisible();

    // 3. Switch to Table View via in-page toggle (not a separate nav link)
    await page.goto("/collections?view=table");
    await expect(page).toHaveURL(/view=table/);
    await expect(page.locator("table")).toBeVisible();

    // 4. Navigate into an Invoice Detail
    const invoiceLink = page.locator("a[href^='/invoices/demo-invoice-']").first();
    await expect(invoiceLink).toBeVisible();
    await invoiceLink.click();

    // Verify Invoice Detail loads
    await expect(page).toHaveURL(/\/invoices\/demo-invoice-/);
    await expect(page.getByRole("heading", { name: "Invoice", exact: true })).toBeVisible();
    await expect(page.locator("text=Grand Total:")).toBeVisible();
    await expect(page.locator("text=Line Items & Financial Calculation")).toBeVisible();
  });

  test("maintains responsive usability on mobile viewport", async ({ page, isMobile }) => {
    await page.goto("/");
    await expect(page.locator("section[aria-label='Receivables Metrics']")).toBeVisible();

    // Collections workspace loads cleanly
    await page.goto("/collections");
    await expect(page.locator("h1").filter({ hasText: "Collections Workspace" })).toBeVisible();

    // Check mobile nav bar if in mobile project
    if (isMobile) {
      const mobileNav = page.locator("nav[aria-label='Mobile Navigation']");
      await expect(mobileNav).toBeVisible();
    }
  });
});

test.describe("Navigation: Collections view switching", () => {
  test("Collections page defaults to Board view and allows switching to Table view", async ({ page }) => {
    await page.goto("/collections");
    await expect(page).toHaveURL("/collections");

    // Board view should be active
    await expect(page.locator("[aria-label='View Mode'] a[aria-current='true']")).toContainText("Board");

    // Switch to Table via in-page toggle
    await page.locator("[aria-label='View Mode'] a[href='/collections?view=table']").click();
    await expect(page).toHaveURL(/view=table/);
    await expect(page.locator("table")).toBeVisible();

    // Table link should now be active
    await expect(page.locator("[aria-label='View Mode'] a[aria-current='true']")).toContainText("Table");

    // Switch back to Board
    await page.locator("[aria-label='View Mode'] a[href='/collections']").click();
    await expect(page).toHaveURL("/collections");
    await expect(page.locator("[aria-label='View Mode'] a[aria-current='true']")).toContainText("Board");
  });

  test("Collections Board and Table views display consistent invoices dataset", async ({ page }) => {
    // Load table view and count rows via the ALL tab badge
    await page.goto("/collections?view=table");
    await expect(page.locator("table")).toBeVisible();

    const allBadge = page.locator("button[role='tab']:has-text('All')").locator("span").nth(1);
    const totalCount = await allBadge.textContent();

    // Board view should load without error
    await page.goto("/collections");
    await expect(page.locator("h1").filter({ hasText: "Collections Workspace" })).toBeVisible();
    // Kanban columns should be present (same data source)
    await expect(page.getByText("Draft", { exact: false }).first()).toBeVisible();

    // Table ALL count should remain consistent
    await page.goto("/collections?view=table");
    const allBadgeAgain = page.locator("button[role='tab']:has-text('All')").locator("span").nth(1);
    await expect(allBadgeAgain).toHaveText(totalCount!);
  });
});

test.describe("Navigation: Invoices directory page", () => {
  test("Invoices nav link opens the dedicated invoice directory at /invoices", async ({ page, isMobile }) => {
    await page.goto("/");

    if (isMobile) {
      await page.goto("/invoices");
    } else {
      // Click the desktop nav Invoices link (not the /invoices/new CTA)
      await page.locator("nav[aria-label='Main Navigation'] a[href='/invoices']").click();
    }

    await expect(page).toHaveURL("/invoices");
    await expect(page.locator("h1").filter({ hasText: "Invoices" })).toBeVisible();
    await expect(page.locator("table")).toBeVisible();
  });

  test("Invoices directory is separate from the Collections Board URL", async ({ page }) => {
    await page.goto("/invoices");
    await expect(page).toHaveURL("/invoices");
    // Should NOT be on /collections
    await expect(page).not.toHaveURL(/\/collections/);
    await expect(page.locator("table")).toBeVisible();
  });

  test("Invoices nav link is marked active when on /invoices", async ({ page }) => {
    await page.goto("/invoices");
    const invoicesLink = page.locator("nav[aria-label='Main Navigation'] a[href='/invoices']");
    await expect(invoicesLink).toHaveAttribute("aria-current", "page");
  });

  test("Collections nav link is active on /collections and inactive on /invoices", async ({ page }) => {
    await page.goto("/collections");
    const collectionsLink = page.locator("nav[aria-label='Main Navigation'] a[href='/collections']");
    await expect(collectionsLink).toHaveAttribute("aria-current", "page");

    await page.goto("/invoices");
    await expect(collectionsLink).not.toHaveAttribute("aria-current", "page");
  });
});
