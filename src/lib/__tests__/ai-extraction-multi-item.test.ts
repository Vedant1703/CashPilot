/**
 * CashPilot AI — Multi-Line-Item AI Extraction Unit Tests (GEN-01)
 *
 * Verifies:
 * - Complex prompts with multiple line items are reliably extracted
 * - Pre-tax subtotal calculates accurately (e.g. 10 * $150 + 5 * $80 = $1,900)
 * - Due dates are derived from payment terms
 * - Thank-you notes are placed in customer-facing notes without truncation or ellipsis
 * - Complete prompt remains preserved
 */

import { describe, it, expect } from "vitest";
import { extractInvoiceDeterministically } from "@/lib/services/ai-extraction.service";
import { computeInvoiceTotals, parseMoneyToMinorUnits } from "@/lib/money";

describe("AI Invoice Extraction Reliability (GEN-01)", () => {
  it("extracts multiple line items, Net 14 terms, and thank-you note from QA report prompt", () => {
    const prompt =
      "Website redesign (10 hours at USD 150/hour), UI revisions (5 hours at USD 80/hour), USD currency, payment due in 14 days and a professional thank-you note";

    const result = extractInvoiceDeterministically(prompt);

    expect(result.isInvoiceIntent).toBe(true);
    expect(result.draft.lineItems).toBeDefined();
    expect(result.draft.lineItems).toHaveLength(2);

    const item1 = result.draft.lineItems![0];
    expect(item1.description).toBe("Website redesign");
    expect(item1.quantity).toBe(10);
    expect(item1.unitPriceDecimal).toBe("150.00");

    const item2 = result.draft.lineItems![1];
    expect(item2.description).toBe("UI revisions");
    expect(item2.quantity).toBe(5);
    expect(item2.unitPriceDecimal).toBe("80.00");

    // Authoritative money calculation: 10 * $150 + 5 * $80 = $1,900
    const lineItemCalculations = result.draft.lineItems!.map((li) => ({
      quantity: li.quantity,
      unitPriceMinorUnits: parseMoneyToMinorUnits(li.unitPriceDecimal) ?? 0,
    }));
    const totals = computeInvoiceTotals(lineItemCalculations, 0);
    expect(totals.subtotalMinorUnits).toBe(190000); // $1,900.00 in integer cents
    expect(totals.totalMinorUnits).toBe(190000);

    // Terms and Due Date
    expect(result.draft.terms).toBe("Net 14 days");
    expect(result.draft.dueDate).toBeDefined();
    const expectedDueDate = new Date(Date.now() + 14 * 86400000).toISOString().substring(0, 10);
    expect(result.draft.dueDate).toBe(expectedDueDate);

    // Thank-you note without ellipsis or truncation
    expect(result.draft.notes).not.toContain("...");
    expect(result.draft.notes).toContain("Thank you for your business");
  });

  it("extracts multiple items with colon format", () => {
    const prompt =
      "Invoice for TechStart: Frontend development: 20 hours at $120/hour, QA testing: 8 hours at $75/hour, net 30";

    const result = extractInvoiceDeterministically(prompt);

    expect(result.draft.lineItems).toHaveLength(2);
    expect(result.draft.lineItems![0].description).toBe("Frontend development");
    expect(result.draft.lineItems![0].quantity).toBe(20);
    expect(result.draft.lineItems![0].unitPriceDecimal).toBe("120.00");

    expect(result.draft.lineItems![1].description).toBe("QA testing");
    expect(result.draft.lineItems![1].quantity).toBe(8);
    expect(result.draft.lineItems![1].unitPriceDecimal).toBe("75.00");

    expect(result.draft.terms).toBe("Net 30 days");
  });

  it("extracts multiple items with quantity-first phrasing", () => {
    const prompt =
      "Bill Acme for 15 hours of security architecture at $200/hr, and 10 hours of code review at $150/hr";

    const result = extractInvoiceDeterministically(prompt);

    expect(result.draft.lineItems).toHaveLength(2);
    expect(result.draft.lineItems![0].description).toBe("Security architecture");
    expect(result.draft.lineItems![0].quantity).toBe(15);
    expect(result.draft.lineItems![0].unitPriceDecimal).toBe("200.00");

    expect(result.draft.lineItems![1].description).toBe("Code review");
    expect(result.draft.lineItems![1].quantity).toBe(10);
    expect(result.draft.lineItems![1].unitPriceDecimal).toBe("150.00");
  });

  it("preserves full prompt in notes when no custom or thank-you note is requested, without truncation or ellipsis", () => {
    const prompt =
      "Bill ClientXYZ for 40 hours of cloud infrastructure migration at $175 per hour with 5% tax and due in 10 days";

    const result = extractInvoiceDeterministically(prompt);

    expect(result.draft.notes).not.toContain("...");
    expect(result.draft.notes).toBe(`Drafted from request: "${prompt}"`);
  });
});
