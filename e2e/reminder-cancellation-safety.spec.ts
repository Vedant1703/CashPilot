import { test, expect } from "@playwright/test";
import {
  setupRemindCancelTestInvoice,
  cleanupE2EInvoices,
  E2E_REMIND_CANCEL_INVOICE_ID,
} from "./fixtures";

test.describe("Journey E: Reminder and Cancellation Safety", () => {
  const EMPTY_SHA256 =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

  test.afterAll(async () => {
    await cleanupE2EInvoices();
  });

  test("Reminder requires explicit approval, activates 24h cooldown, and preserves unpaid status", async ({
    page,
  }) => {
    await setupRemindCancelTestInvoice({ withCooldown: false });

    let remindCallCount = 0;
    let approveCallCount = 0;

    await page.route("**/api/invoices/*/approve*", async (route) => {
      approveCallCount++;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            approvalId: "appr-remind-mock-01",
            actionType: "SEND_REMINDER",
          },
        }),
      });
    });

    await page.route("**/api/invoices/*/remind*", async (route) => {
      remindCallCount++;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            operationId: "op-remind-mock-01",
            invoiceId: E2E_REMIND_CANCEL_INVOICE_ID,
            paypalInvoiceId: "INV2-E2E-SENT-02",
            recipientEmail: "finance@acme-e2e.example.com",
            reminded: true,
            remindedAt: new Date().toISOString(),
          },
        }),
      });
    });

    await page.goto(`/invoices/${E2E_REMIND_CANCEL_INVOICE_ID}`);

    // Verify initial invoice state
    await expect(page.getByRole("heading", { level: 1 })).toContainText("INV-E2E-SENT-02");
    await expect(
      page.locator("span[role='status']").filter({ hasText: /Awaiting Payment/i })
    ).toBeVisible();

    // Verify Send reminder action button exists
    const remindBtn = page.getByRole("button", { name: /payment reminder|Send reminder/i });
    await expect(remindBtn).toBeVisible();

    // Open Reminder Approval Modal
    await remindBtn.click();

    const modal = page.locator("div[role='dialog']");
    await expect(modal).toBeVisible();
    await expect(modal.getByRole("heading", { name: /Approve Payment Reminder/i })).toBeVisible();

    // Material hash lock assertion
    const hashElement = modal.locator(".font-mono.text-\\[10px\\]");
    await expect(hashElement).toBeVisible();
    const hashText = (await hashElement.textContent())?.trim() ?? "";
    expect(hashText.length).toBe(64);
    expect(hashText).toMatch(/^[0-9a-f]{64}$/);
    expect(hashText).not.toBe(EMPTY_SHA256);

    // Safety Invariant: ZERO remind requests fired before clicking confirm
    expect(remindCallCount).toBe(0);
    expect(approveCallCount).toBe(0);

    // Confirm reminder
    const confirmBtn = modal.getByRole("button", {
      name: /Approve and send reminder via PayPal/i,
    });
    await expect(confirmBtn).toBeVisible();
    await confirmBtn.click();

    // Modal closes on success
    await expect(modal).not.toBeVisible();

    expect(approveCallCount).toBe(1);
    expect(remindCallCount).toBe(1);

    // Success alert verified
    await expect(page.getByText(/Payment Reminder Sent via PayPal Sandbox/i)).toBeVisible();
    await expect(page.getByText(/Invoice status remains AWAITING_PAYMENT/i)).toBeVisible();

    // Financial Integrity Invariant:
    // A reminder does NOT alter payment status. Invoice remains Awaiting Payment, never Paid.
    await expect(
      page.locator("span[role='status']").filter({ hasText: /Awaiting Payment/i })
    ).toBeVisible();
    await expect(
      page.locator("span[role='status']").filter({ hasText: /\bPaid\b/i })
    ).not.toBeVisible();

    // Verify cooldown UI: Send reminder button is now disabled with cooldown notice
    const cooldownBtn = page.getByRole("button", { name: /cooldown active/i });
    await expect(cooldownBtn).toBeVisible();
    await expect(cooldownBtn).toBeDisabled();
    await expect(page.getByText(/Reminder in cooldown/i)).toBeVisible();
  });

  test("Pre-existing 24-hour reminder cooldown renders button disabled", async ({ page }) => {
    // Seed with active cooldown record in externalOperation
    await setupRemindCancelTestInvoice({ withCooldown: true });

    await page.goto(`/invoices/${E2E_REMIND_CANCEL_INVOICE_ID}`);

    const cooldownBtn = page.getByRole("button", { name: /cooldown active/i });
    await expect(cooldownBtn).toBeVisible();
    await expect(cooldownBtn).toBeDisabled();
    await expect(page.getByText(/Reminder in cooldown/i)).toBeVisible();
    await expect(cooldownBtn).toHaveAttribute(
      "aria-label",
      "Send reminder disabled: 24-hour cooldown active"
    );
  });

  test("Cancellation communicates destructive consequences, requires approval, preserves state on timeout, and voids on server confirmation", async ({
    page,
  }) => {
    await setupRemindCancelTestInvoice({ withCooldown: false });

    let cancelCallCount = 0;

    await page.route("**/api/invoices/*/approve*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            approvalId: "appr-cancel-mock-01",
            actionType: "CANCEL_INVOICE",
          },
        }),
      });
    });

    await page.goto(`/invoices/${E2E_REMIND_CANCEL_INVOICE_ID}`);

    const cancelBtn = page.getByRole("button", { name: /Cancel invoice/i });
    await expect(cancelBtn).toBeVisible();
    await cancelBtn.click();

    const modal = page.locator("div[role='dialog']");
    await expect(modal).toBeVisible();
    await expect(modal.getByRole("heading", { name: /Approve Invoice Cancellation/i })).toBeVisible();

    // Verify irreversible consequence notice is prominent
    await expect(
      modal.getByText(/Human Approval Gate · Irreversible Action/i)
    ).toBeVisible();
    await expect(
      modal.getByText(/PayPal Sandbox will immediately void this invoice/i)
    ).toBeVisible();
    await expect(
      modal.getByText(/payment cannot be recorded against this invoice/i)
    ).toBeVisible();

    // Verify hash lock
    const hashElement = modal.locator(".font-mono.text-\\[10px\\]");
    await expect(hashElement).toBeVisible();
    const hashText = (await hashElement.textContent())?.trim() ?? "";
    expect(hashText.length).toBe(64);
    expect(hashText).not.toBe(EMPTY_SHA256);

    // 1. Simulate Timeout / Unknown Outcome on Cancel
    await page.route("**/api/invoices/*/cancel*", async (route) => {
      cancelCallCount++;
      await route.fulfill({
        status: 504,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          error: "PayPal Sandbox request timed out. Outcome is unknown.",
          code: "OPERATION_UNKNOWN_OUTCOME",
        }),
      });
    });

    const confirmBtn = modal.getByRole("button", {
      name: /Approve and cancel on PayPal/i,
    });
    await confirmBtn.click();

    // Modal stays visible with error message
    await expect(modal).toBeVisible();
    await expect(
      modal.getByText(/Outcome is unknown; no blind retry will be made/i)
    ).toBeVisible();

    // Verify only 1 attempt occurred, no blind retry
    expect(cancelCallCount).toBe(1);

    // Dismiss modal and verify invoice has NOT been marked Cancelled prematurely
    const keepActiveBtn = modal.getByRole("button", { name: /Keep invoice active/i });
    await keepActiveBtn.click();
    await expect(modal).not.toBeVisible();

    // Status remains AWAITING_PAYMENT (financial truth preserved)
    await expect(
      page.locator("span[role='status']").filter({ hasText: /Awaiting Payment/i })
    ).toBeVisible();
    await expect(
      page.locator("span[role='status']").filter({ hasText: /Cancelled/i })
    ).not.toBeVisible();

    // 2. Now execute server-confirmed cancellation
    await cancelBtn.click();
    await expect(modal).toBeVisible();

    await page.route("**/api/invoices/*/cancel*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            operationId: "op-cancel-mock-success",
            invoiceId: E2E_REMIND_CANCEL_INVOICE_ID,
            paypalInvoiceId: "INV2-E2E-SENT-02",
            previousStatus: "AWAITING_PAYMENT",
            currentStatus: "CANCELLED",
            previousPaypalStatus: "SENT",
            currentPaypalStatus: "CANCELLED",
            cancelledAt: new Date().toISOString(),
          },
        }),
      });
    });

    const confirmSuccessBtn = modal.getByRole("button", {
      name: /Approve and cancel on PayPal/i,
    });
    await confirmSuccessBtn.click();

    await expect(modal).not.toBeVisible();

    // Verify success banner and updated status
    await expect(page.getByText(/Invoice Cancelled on PayPal Sandbox/i)).toBeVisible();
    await expect(page.getByText(/Workflow status updated to CANCELLED/i)).toBeVisible();

    // Status is now Cancelled, and definitely NOT Paid
    await expect(
      page.locator("span[role='status']").filter({ hasText: /Cancelled/i })
    ).toBeVisible();
    await expect(
      page.locator("span[role='status']").filter({ hasText: /\bPaid\b/i })
    ).not.toBeVisible();
  });
});
