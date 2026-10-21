import { test, expect } from "@playwright/test";

test.describe("Journey C: Invoice Detail and Status Sync", () => {
  test("displays invoice details with CashPilot/PayPal status separation, safely reconciles status, and preserves state on provider error", async ({
    page,
  }) => {
    // 1. Navigate to seeded demo invoice
    await page.goto("/invoices/demo-invoice-1");
    await expect(page).toHaveTitle(/CashPilot/i);

    // Verify invoice heading and client info
    await expect(page.getByRole("heading", { name: "Invoice", exact: true })).toBeVisible();
    await expect(page.getByText("UX Design Services — Q4 2026")).toBeVisible();
    await expect(page.getByText("Acme Corporation")).toBeVisible();

    // Verify CashPilot status and PayPal status are separated
    await expect(page.getByText("CashPilot State:")).toBeVisible();
    await expect(page.getByText("Provider Status:")).toBeVisible();

    // Verify financial calculation summary
    await expect(page.getByText("Line Items & Financial Calculation")).toBeVisible();
    await expect(page.getByText("Grand Total:")).toBeVisible();

    // 2. Test Safe Status Sync with Mocked Reconciled Response
    await page.route("**/api/invoices/demo-invoice-1/sync*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            invoiceId: "demo-invoice-1",
            previousCashpilotStatus: "DRAFT",
            currentCashpilotStatus: "AWAITING_PAYMENT",
            previousPaypalStatus: "DRAFT",
            currentPaypalStatus: "SENT",
            lastSyncAt: new Date().toISOString(),
            statusChanged: true,
            hasPaypalInvoice: true,
          },
        }),
      });
    });

    const syncBtn = page.getByRole("button", {
      name: /Synchronize status with PayPal Sandbox|Sync status/i,
    });
    await expect(syncBtn).toBeVisible();
    await syncBtn.click();

    // Verify successful reconciliation alert appears
    await expect(page.getByText(/Status Reconciled with PayPal Sandbox/i)).toBeVisible();
    await expect(page.getByText(/Status updated: DRAFT → AWAITING_PAYMENT/i)).toBeVisible();

    // Financial invariant assertion: A synced sent invoice is NOT marked PAID
    await expect(page.locator("span[role='status']").filter({ hasText: /^Paid$/i })).not.toBeVisible();

    // 3. Test Provider Failure / Timeout preservation of last known state
    await page.route("**/api/invoices/demo-invoice-1/sync*", async (route) => {
      await route.fulfill({
        status: 504,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          error: "PayPal Sandbox API timed out while checking invoice status.",
          code: "TIMEOUT",
        }),
      });
    });

    await syncBtn.click();

    // Verify error banner and stale preservation feedback
    await expect(page.getByText(/PayPal Sandbox Request Timed Out/i)).toBeVisible();
    await expect(
      page.getByText(/previous known status has been preserved as stale/i)
    ).toBeVisible();

    // Status remains AWAITING_PAYMENT — NEVER converted to PAID on failed sync
    await expect(page.locator("span[role='status']").filter({ hasText: /^Paid$/i })).not.toBeVisible();
  });
});
