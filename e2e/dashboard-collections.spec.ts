import { test, expect } from "@playwright/test";

test.describe("Journey A: Dashboard and Collections", () => {
  test("loads dashboard, renders metrics, and navigates to collections", async ({
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

    // Collections is board-only — verify Kanban columns are rendered
    await expect(page.getByText("Awaiting Payment", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Overdue", { exact: false }).first()).toBeVisible();
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

test.describe("Collections: Kanban board only", () => {
  test("Collections page renders the Kanban board and does NOT render a Board/Table toggle", async ({
    page,
  }) => {
    await page.goto("/collections");
    await expect(page.locator("h1").filter({ hasText: "Collections Workspace" })).toBeVisible();

    // Kanban columns must be present
    await expect(page.getByText("Draft", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Awaiting Payment", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Overdue", { exact: false }).first()).toBeVisible();

    // No Board/Table view toggle must exist on the Collections page
    await expect(page.locator("[aria-label='View Mode']")).not.toBeVisible();

    // No <table> element on the default Collections page
    await expect(page.locator("table")).not.toBeVisible();
  });

  test("Collections page with ?stage param still loads the board", async ({ page }) => {
    // Dashboard deep-links use ?stage=overdue; Collections should still show the board
    await page.goto("/collections?stage=overdue");
    await expect(page.locator("h1").filter({ hasText: "Collections Workspace" })).toBeVisible();
    await expect(page.getByText("Overdue", { exact: false }).first()).toBeVisible();
    // Board — no table
    await expect(page.locator("table")).not.toBeVisible();
  });

  test("Invoice cards on the board link to invoice detail pages", async ({ page }) => {
    await page.goto("/collections");
    await expect(page.locator("h1").filter({ hasText: "Collections Workspace" })).toBeVisible();

    // At least one card link to /invoices/[id] must exist
    const invoiceLink = page.locator("a[href^='/invoices/demo-invoice-']").first();
    await expect(invoiceLink).toBeVisible();
    await invoiceLink.click();

    await expect(page).toHaveURL(/\/invoices\/demo-invoice-/);
    await expect(page.getByRole("heading", { name: "Invoice", exact: true })).toBeVisible();
    await expect(page.locator("text=Grand Total:")).toBeVisible();
  });
});

test.describe("Navigation: Invoices directory page", () => {
  test("Invoices nav link opens the dedicated invoice directory at /invoices", async ({
    page,
    isMobile,
  }) => {
    await page.goto("/");

    if (isMobile) {
      await page.goto("/invoices");
    } else {
      // Desktop nav: click the Invoices link (not the /invoices/new CTA button)
      await page.locator("nav[aria-label='Main Navigation'] a[href='/invoices']").click();
    }

    await expect(page).toHaveURL("/invoices");
    await expect(page.locator("h1").filter({ hasText: "Invoices" })).toBeVisible();
    await expect(page.locator("table")).toBeVisible();
  });

  test("Invoices directory is separate from the Collections Board URL", async ({ page }) => {
    await page.goto("/invoices");
    await expect(page).toHaveURL("/invoices");
    await expect(page).not.toHaveURL(/\/collections/);
    await expect(page.locator("table")).toBeVisible();
  });

  test("Invoices directory shows all status filter tabs", async ({ page }) => {
    await page.goto("/invoices");
    await expect(page.locator("table")).toBeVisible();

    const tabList = page.locator("[role='tablist']");
    await expect(tabList).toBeVisible();
    await expect(tabList.locator("button", { hasText: "All" })).toBeVisible();
    await expect(tabList.locator("button", { hasText: "Draft" })).toBeVisible();
    await expect(tabList.locator("button", { hasText: "Overdue" })).toBeVisible();
    await expect(tabList.locator("button", { hasText: "Paid" })).toBeVisible();
  });

  test("Invoices directory navigates to invoice detail", async ({ page }) => {
    await page.goto("/invoices");
    await expect(page.locator("table")).toBeVisible();

    const invoiceLink = page.locator("a[href^='/invoices/demo-invoice-']").first();
    await expect(invoiceLink).toBeVisible();
    await invoiceLink.click();

    await expect(page).toHaveURL(/\/invoices\/demo-invoice-/);
    await expect(page.getByRole("heading", { name: "Invoice", exact: true })).toBeVisible();
    await expect(page.locator("text=Grand Total:")).toBeVisible();
    await expect(page.locator("text=Line Items & Financial Calculation")).toBeVisible();
  });

  test("Invoices nav link is marked active when on /invoices", async ({ page }) => {
    await page.goto("/invoices");
    const invoicesLink = page.locator("nav[aria-label='Main Navigation'] a[href='/invoices']");
    await expect(invoicesLink).toHaveAttribute("aria-current", "page");
  });

  test("Collections nav link is active on /collections and inactive on /invoices", async ({
    page,
  }) => {
    await page.goto("/collections");
    const collectionsLink = page
      .locator("nav[aria-label='Main Navigation'] a[href='/collections']")
      .first();
    await expect(collectionsLink).toHaveAttribute("aria-current", "page");

    await page.goto("/invoices");
    const collectionsLinkAgain = page
      .locator("nav[aria-label='Main Navigation'] a[href='/collections']")
      .first();
    await expect(collectionsLinkAgain).not.toHaveAttribute("aria-current", "page");
  });
});
