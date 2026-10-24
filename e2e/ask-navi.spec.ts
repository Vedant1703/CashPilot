import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { test, expect } from "@playwright/test";
import { setupRemindCancelTestInvoice, cleanupE2EInvoices, E2E_REMIND_CANCEL_INVOICE_ID } from "./fixtures";

test.describe("Ask Navi Guided Chatbot & Navigation", () => {
  test("renders Ask Navi in desktop navigation and navigates to /navi-ai", async ({ page, isMobile }) => {
    test.skip(isMobile, "Desktop navigation is only rendered on desktop viewports");
    await page.goto("/");

    // Check desktop nav has Ask Navi link
    const naviLink = page.locator("nav[aria-label='Main Navigation'] a[href='/navi-ai']").first();
    await expect(naviLink).toBeVisible();
    await expect(naviLink).toHaveText("Ask Navi");

    // Click Ask Navi
    await naviLink.click();
    await expect(page).toHaveURL(/\/navi-ai/);

    // Verify page heading and grounding subtitle
    await expect(page.locator("h1")).toContainText("Ask Navi");
    await expect(
      page.getByText("Answers come from your invoices and PayPal's status, nothing else").first()
    ).toBeVisible();
  });

  test("Ask Navi is strictly guided with NO free-text input or send button", async ({ page }) => {
    await page.goto("/navi-ai");

    // Verify NO text input and NO send button exist in the UI
    const textInput = page.getByRole("textbox");
    await expect(textInput).toHaveCount(0);

    const sendBtn = page.getByRole("button", { name: /^send/i });
    await expect(sendBtn).toHaveCount(0);

    // Verify guided question buttons are present in the guided grid
    const attentionBtn = page.getByRole("button", { name: "Which invoices need attention first?" }).first();
    await expect(attentionBtn).toBeVisible();

    const summarizeAllBtn = page.getByRole("button", { name: "Summarize all invoices" }).first();
    await expect(summarizeAllBtn).toBeVisible();

    const listAllBtn = page.getByRole("button", { name: "List all invoices" }).first();
    await expect(listAllBtn).toBeVisible();

    // Check "Ranked for you" panel
    await expect(page.getByText("Ranked for you")).toBeVisible();
    await expect(page.getByText("Deterministic rule-based order")).toBeVisible();
  });

  test("clicking a guided question renders grounded response, action buttons, and follow-ups", async ({ page }) => {
    await page.goto("/navi-ai");

    // Click "Which invoices need attention first?"
    const attentionBtn = page.getByRole("button", { name: "Which invoices need attention first?" }).first();
    await attentionBtn.click();

    // Wait for assistant response
    const assistantBadge = page.locator("span", { hasText: "AI proposed" }).first();
    await expect(assistantBadge).toBeVisible({ timeout: 10000 });

    // Verify deterministic explanation rule text
    await expect(
      page.getByText("Ranking is rule-based, so the same data always gives the same order").first()
    ).toBeVisible();

    // Check action buttons exist
    const openInvoiceAction = page.getByRole("link", { name: "Open invoice" }).first();
    await expect(openInvoiceAction).toBeVisible();

    // Check contextual follow-up questions appear
    await expect(page.getByText("Follow-up questions")).toBeVisible();
    const followUpBtn = page.locator("button", { hasText: "Show overdue invoices" }).first();
    await expect(followUpBtn).toBeVisible();

    // Click follow-up question
    await followUpBtn.click();

    // Verify second response appears with overdue invoice info
    await expect(page.getByText(/overdue invoice/i).first()).toBeVisible({ timeout: 10000 });
  });

  test("client summary option allows selecting actual client from records", async ({ page }) => {
    await page.goto("/navi-ai");

    // If client summary button is present, click it to show actual client options
    const clientSummaryToggle = page.getByRole("button", { name: /Client summary/i });
    if (await clientSummaryToggle.isVisible()) {
      await clientSummaryToggle.click();

      // Verify client pill buttons appear with data-testid
      const clientBtn = page.getByTestId("client-option-btn").first();
      await expect(clientBtn).toBeVisible();
      await clientBtn.click();

      // Wait for response
      await expect(page.getByText(/Summary for /i).first()).toBeVisible({ timeout: 10000 });
    }
  });

  test("mobile navigation includes Ask Navi link", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/");

    const mobileNavi = page.locator("nav[aria-label='Mobile Navigation'] a[href='/navi-ai']");
    await expect(mobileNavi).toBeVisible();
    await expect(mobileNavi).toContainText("Ask Navi");
  });
});

test.describe("Reminder Deep Link & Approval Gate Verification", () => {
  test.afterAll(async () => {
    await cleanupE2EInvoices();
  });

  test("opens reminder approval modal on eligible invoice via ?action=remind without autonomous sending", async ({ page }) => {
    // demo-invoice-3 is OVERDUE with PayPal status SENT (eligible)
    await page.goto("/invoices/demo-invoice-3?action=remind");

    // Modal should automatically open
    const modalHeading = page.getByRole("heading", { name: "Approve Payment Reminder" });
    await expect(modalHeading).toBeVisible({ timeout: 8000 });

    // Explicit approval button must be visible (no autonomous execution occurred)
    const approveButton = page.getByRole("button", { name: /Approve and send reminder via PayPal/i });
    await expect(approveButton).toBeVisible();

    // Close the modal cleanly via "Back to invoice"
    const closeBtn = page.getByRole("button", { name: "Back to invoice" });
    await closeBtn.click();
    await expect(modalHeading).not.toBeVisible();
  });

  test("does NOT open reminder approval modal on ineligible invoice via ?action=remind", async ({ page }) => {
    // demo-invoice-1 is DRAFT without PayPal invoice ID (ineligible)
    await page.goto("/invoices/demo-invoice-1?action=remind");

    const modalHeading = page.getByRole("heading", { name: "Approve Payment Reminder" });
    await expect(modalHeading).not.toBeVisible();
  });

  test("does NOT open reminder modal when invoice is in 24h cooldown", async ({ page }) => {
    // Set up invoice in active 24h cooldown
    await setupRemindCancelTestInvoice({ withCooldown: true });

    await page.goto(`/invoices/${E2E_REMIND_CANCEL_INVOICE_ID}?action=remind`);

    // Modal must NOT open because cooldown is active
    const modalHeading = page.getByRole("heading", { name: "Approve Payment Reminder" });
    await expect(modalHeading).not.toBeVisible();

    // Cooldown badge/button should be displayed
    await expect(page.getByText("Reminder in cooldown")).toBeVisible();
  });

  test("does NOT open reminder modal when navigating without ?action=remind", async ({ page }) => {
    // Navigate to eligible invoice without the action query param
    await page.goto("/invoices/demo-invoice-3");

    const modalHeading = page.getByRole("heading", { name: "Approve Payment Reminder" });
    await expect(modalHeading).not.toBeVisible();
  });

  test("navigation between invoices does not keep reminder modal open", async ({ page }) => {
    // Navigate to eligible invoice with ?action=remind
    await page.goto("/invoices/demo-invoice-3?action=remind");
    const modalHeading = page.getByRole("heading", { name: "Approve Payment Reminder" });
    await expect(modalHeading).toBeVisible({ timeout: 8000 });

    // Navigate to invoice without ?action=remind
    await page.goto("/invoices/demo-invoice-1");
    await expect(modalHeading).not.toBeVisible();
  });

  test("Draft a reminder action in Ask Navi opens the existing approval modal", async ({ page }) => {
    await page.goto("/navi-ai");

    // Click "Which invoices need attention first?"
    const attentionBtn = page.getByRole("button", { name: "Which invoices need attention first?" }).first();
    await attentionBtn.click();

    // Wait for response and find "Draft a reminder" link
    const draftReminderAction = page.getByRole("link", { name: "Draft a reminder" }).first();
    await expect(draftReminderAction).toBeVisible({ timeout: 10000 });
    await expect(draftReminderAction).toHaveAttribute("href", /\?action=remind/);

    // Click the action to navigate
    await draftReminderAction.click();

    // Verify navigation landed on invoice detail and opened the approval modal
    await expect(page).toHaveURL(/\/invoices\/.*action=remind/);
    const modalHeading = page.getByRole("heading", { name: "Approve Payment Reminder" });
    await expect(modalHeading).toBeVisible({ timeout: 8000 });
  });
});
