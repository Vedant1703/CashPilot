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

    // 3. Switch to Table View
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
