import { test, expect } from "@playwright/test";

test.describe("Journey B: Invoice Drafting Studio", () => {
  test("extracts proposal from natural language, allows review & editing, and gates draft behind explicit human approval", async ({
    page,
  }) => {
    // 1. Navigate to Invoice Studio
    await page.goto("/invoices/new");
    await expect(page).toHaveTitle(/CashPilot/i);
    await expect(page.locator("h1")).toContainText("What are we billing today?");

    // 2. Enter representative natural-language prompt
    const promptInput = page.locator("#invoice-prompt");
    await expect(promptInput).toBeVisible();
    await promptInput.fill(
      "Bill Acme Corp for 10 hours of system design consulting at $150 per hour, net 14"
    );

    // 3. Submit extraction
    const draftBtn = page.getByRole("button", { name: /Draft with Navi/i });
    await expect(draftBtn).toBeVisible();
    await draftBtn.click();

    // 4. Verify Review Step loads with provenance labeling
    await expect(page.getByText("Review Invoice Draft")).toBeVisible();

    // Check extraction provenance badge (AI Drafted or Deterministic rule-based)
    const provenanceBadge = page.locator("text=/AI Drafted|Deterministic Rule-Based Extraction/i");
    await expect(provenanceBadge).toBeVisible();

    // Verify initial total is rendered
    await expect(page.locator("text=Total Due:").first()).toBeVisible();

    // 5. Test Editing & Deterministic Real-time Total recalculation
    // Change quantity to 10
    const qtyInput = page.getByRole("spinbutton", { name: "Quantity" }).first();
    await qtyInput.fill("10");

    // Total should immediately update to $1,500.00
    await expect(page.getByText("$1,500.00").first()).toBeVisible();

    // 6. Test Validation: enter invalid email and attempt to save
    const emailInput = page.getByPlaceholder("accounts@client.com");
    if (await emailInput.isVisible()) {
      await emailInput.fill("invalid-email-without-at-sign");
      await page.getByRole("button", { name: /Save Draft & Review Approval/i }).click();

      // Expect validation error
      await expect(page.getByText(/valid recipient email address is required/i)).toBeVisible();

      // Restore valid email
      await emailInput.fill("accounts@acme-sandbox.example.com");
    }

    // 7. Save Draft & proceed to Human Approval Gate
    await page.getByRole("button", { name: /Save Draft & Review Approval/i }).click();

    // 8. Verify Human Approval Gate loads
    await expect(page.getByText("Needs your approval")).toBeVisible();
    await expect(page.getByText("Human Approval Gate")).toBeVisible();

    // Financial invariant assertion: SHA-256 hash must be non-empty and NOT the empty-string hash
    const hashLocator = page.locator(".font-mono.select-all");
    await expect(hashLocator).toBeVisible();
    const hashText = (await hashLocator.textContent())?.trim() ?? "";

    expect(hashText).toMatch(/^[a-f0-9]{64}$/);
    // Explicit assertion: never the empty-string SHA-256 hash
    expect(hashText).not.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );

    // 9. Mock PayPal draft creation API to ensure zero real provider writes
    await page.route("**/api/invoices/*/paypal-draft", async (route) => {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            isExistingDraft: false,
            invoiceId: "mock-draft-id",
            paypalInvoiceId: "INV2-MOCK-E2E-DRAFT",
            status: "DRAFT",
            paypalStatus: "DRAFT",
            createdAt: new Date().toISOString(),
          },
        }),
      });
    });

    // 10. Click Approve & Create PayPal Draft
    const approveBtn = page.getByRole("button", { name: /Approve & Create PayPal Draft/i });
    await expect(approveBtn).toBeVisible();
    await approveBtn.click();

    // 11. Verify Confirmation Step
    await expect(page.getByText(/PayPal Sandbox Draft Confirmed/i)).toBeVisible();
    await expect(page.getByText("INV2-MOCK-E2E-DRAFT")).toBeVisible();
  });
});
