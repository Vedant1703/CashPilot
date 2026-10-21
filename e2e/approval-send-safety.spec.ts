import { test, expect } from "@playwright/test";
import {
  setupSendTestInvoice,
  cleanupE2EInvoices,
  E2E_SEND_INVOICE_ID,
} from "./fixtures";

test.describe("Journey D: Approval and Send Safety", () => {
  const EMPTY_SHA256 =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

  test.afterAll(async () => {
    await cleanupE2EInvoices();
  });

  test("Send flow requires explicit human approval, locks material payload, and never marks sent invoice as Paid", async ({
    page,
  }) => {
    await setupSendTestInvoice();

    let sendRequestCount = 0;
    let approveRequestCount = 0;

    await page.route("**/api/invoices/*/approve*", async (route) => {
      approveRequestCount++;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            approvalId: "appr-send-mock-01",
            actionType: "SEND_INVOICE",
          },
        }),
      });
    });

    await page.route("**/api/invoices/*/send*", async (route) => {
      sendRequestCount++;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            operationId: "op-send-mock-01",
            invoiceId: E2E_SEND_INVOICE_ID,
            paypalInvoiceId: "INV2-E2E-DRAFT-SEND-01",
            paypalStatus: "SENT",
            cashpilotStatus: "AWAITING_PAYMENT",
            sentAt: new Date().toISOString(),
          },
        }),
      });
    });

    await page.goto(`/invoices/${E2E_SEND_INVOICE_ID}`);

    // Verify initial invoice details and DRAFT status
    await expect(page.getByRole("heading", { level: 1 })).toContainText("INV-E2E-SEND-01");
    await expect(page.locator("span[role='status']").filter({ hasText: /Draft/i })).toBeVisible();

    // Verify Send Invoice action button is available for eligible draft
    const sendBtn = page.getByRole("button", { name: /Send invoice/i });
    await expect(sendBtn).toBeVisible();

    // Open Send Approval Modal
    await sendBtn.click();

    const modal = page.locator("div[role='dialog']");
    await expect(modal).toBeVisible();
    await expect(modal.getByRole("heading", { name: /Approve and Send Invoice/i })).toBeVisible();

    // Verify material summary details shown in modal
    await expect(modal.getByText(/accounts@acme-sandbox\.example\.com|finance@acme-e2e\.example\.com/i)).toBeVisible();
    await expect(modal.getByText(/INV2-E2E-DRAFT-SEND-01/i)).toBeVisible();
    await expect(modal.getByText("$500.00").first()).toBeVisible();

    // Financial invariant assertion: Hash is present, 64-char hex, and NEVER empty string hash
    const hashElement = modal.locator(".font-mono.text-\\[10px\\]");
    await expect(hashElement).toBeVisible();
    const hashText = (await hashElement.textContent())?.trim() ?? "";
    expect(hashText.length).toBe(64);
    expect(hashText).toMatch(/^[0-9a-f]{64}$/);
    expect(hashText).not.toBe(EMPTY_SHA256);

    // Safety Invariant: ZERO send requests fired before user clicks confirm
    expect(sendRequestCount).toBe(0);
    expect(approveRequestCount).toBe(0);

    // Submit Approval & Send
    const confirmBtn = modal.getByRole("button", { name: /Approve and send via PayPal/i });
    await expect(confirmBtn).toBeVisible();
    await confirmBtn.click();

    // Modal should close on success
    await expect(modal).not.toBeVisible();

    // Verify both approval and send API routes were called exactly once
    expect(approveRequestCount).toBe(1);
    expect(sendRequestCount).toBe(1);

    // Verify user-facing success alert matches server outcome
    await expect(page.getByText(/Invoice Sent via PayPal Sandbox/i)).toBeVisible();
    await expect(page.getByText(/Workflow status updated to Awaiting Payment/i)).toBeVisible();

    // Financial Integrity Invariant:
    // Sending an invoice results in an UNPAID state (Awaiting Payment). It is NEVER marked Paid.
    await expect(
      page.locator("span[role='status']").filter({ hasText: /Awaiting Payment/i })
    ).toBeVisible();
    await expect(
      page.locator("span[role='status']").filter({ hasText: /\bPaid\b/i })
    ).not.toBeVisible();
  });

  test("Send timeout/unknown outcome does NOT blindly retry and preserves state", async ({
    page,
  }) => {
    await setupSendTestInvoice();

    let sendCallCount = 0;

    await page.route("**/api/invoices/*/approve*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            approvalId: "appr-timeout-01",
            actionType: "SEND_INVOICE",
          },
        }),
      });
    });

    await page.route("**/api/invoices/*/send*", async (route) => {
      sendCallCount++;
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

    await page.goto(`/invoices/${E2E_SEND_INVOICE_ID}`);

    const sendBtn = page.getByRole("button", { name: /Send invoice/i });
    await sendBtn.click();

    const modal = page.locator("div[role='dialog']");
    await expect(modal).toBeVisible();

    const confirmBtn = modal.getByRole("button", { name: /Approve and send via PayPal/i });
    await confirmBtn.click();

    // Modal remains visible showing the unknown outcome warning
    await expect(modal).toBeVisible();
    await expect(modal.getByRole("alert")).toBeVisible();
    await expect(
      modal.getByText(/Outcome is unknown; no blind retry will be made/i)
    ).toBeVisible();

    // Wait to guarantee no automatic client background retry occurs
    await page.waitForTimeout(1000);
    expect(sendCallCount).toBe(1);

    // Cancel modal and verify invoice remains DRAFT, NOT PAID
    const backBtn = modal.getByRole("button", { name: /Back to invoice/i });
    await backBtn.click();
    await expect(modal).not.toBeVisible();

    await expect(page.locator("span[role='status']").filter({ hasText: /Draft/i })).toBeVisible();
    await expect(
      page.locator("span[role='status']").filter({ hasText: /\bPaid\b/i })
    ).not.toBeVisible();
  });
});
