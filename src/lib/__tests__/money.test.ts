/**
 * CashPilot AI — Money Utilities Tests
 *
 * SRS §3: Financial amounts must use fixed-precision or integer minor units
 * AGENTS.md §4: Never use JavaScript floating-point arithmetic for money
 *
 * Tests cover:
 *   - Line item total calculation
 *   - Subtotal aggregation
 *   - Tax calculation (integer rounding)
 *   - Total computation
 *   - Display formatting (never for arithmetic)
 *   - Input parsing
 *   - Rejection of non-integer inputs
 *   - Edge cases: zero, large values, boundary rounding
 */

import { describe, it, expect } from "vitest";
import {
  calculateLineItemTotal,
  calculateSubtotal,
  calculateTax,
  calculateTotal,
  computeInvoiceTotals,
  formatMoney,
  parseMoneyToMinorUnits,
  isValidCurrencyCode,
  minorUnitsToDecimalString,
} from "@/lib/money";

// ─────────────────────────────────────────────────────────────────────────────
// calculateLineItemTotal
// ─────────────────────────────────────────────────────────────────────────────

describe("calculateLineItemTotal", () => {
  it("calculates quantity × unit price correctly", () => {
    expect(calculateLineItemTotal(10, 15000)).toBe(150000); // 10 × $150.00
  });

  it("handles quantity of 1", () => {
    expect(calculateLineItemTotal(1, 25000)).toBe(25000); // 1 × $250.00
  });

  it("handles zero quantity", () => {
    expect(calculateLineItemTotal(0, 15000)).toBe(0);
  });

  it("handles zero price", () => {
    expect(calculateLineItemTotal(5, 0)).toBe(0);
  });

  it("rejects negative quantity", () => {
    expect(() => calculateLineItemTotal(-1, 15000)).toThrow();
  });

  it("rejects negative unit price", () => {
    expect(() => calculateLineItemTotal(5, -100)).toThrow();
  });

  it("rejects float quantity", () => {
    expect(() => calculateLineItemTotal(2.5, 15000)).toThrow();
  });

  it("rejects float unit price", () => {
    expect(() => calculateLineItemTotal(5, 150.50)).toThrow();
  });

  it("handles large values without overflow for normal invoices", () => {
    // 100 × $999,999.99 = $99,999,999.00
    expect(calculateLineItemTotal(100, 99999999)).toBe(9999999900);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// calculateSubtotal
// ─────────────────────────────────────────────────────────────────────────────

describe("calculateSubtotal", () => {
  it("sums multiple line item totals", () => {
    expect(calculateSubtotal([150000, 262500, 100000])).toBe(512500);
  });

  it("returns 0 for empty array", () => {
    expect(calculateSubtotal([])).toBe(0);
  });

  it("handles single item", () => {
    expect(calculateSubtotal([75000])).toBe(75000);
  });

  it("rejects non-integer totals", () => {
    expect(() => calculateSubtotal([150000, 262500.5])).toThrow();
  });

  it("rejects negative totals", () => {
    expect(() => calculateSubtotal([150000, -100])).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// calculateTax
// ─────────────────────────────────────────────────────────────────────────────

describe("calculateTax", () => {
  it("calculates 10% tax correctly", () => {
    // 10% = 1000 basis points
    // $5,125.00 subtotal → $512.50 tax
    expect(calculateTax(512500, 1000)).toBe(51250);
  });

  it("calculates 8.5% tax correctly (rounds to integer)", () => {
    // 8.5% = 850 basis points
    // $100.00 subtotal → $8.50 tax
    expect(calculateTax(10000, 850)).toBe(850);
  });

  it("handles odd rounding correctly", () => {
    // 7% = 700 basis points
    // $33.33 subtotal (3333 minor units)
    // 3333 × 700 / 10000 = 233.31 → rounds to 233
    expect(calculateTax(3333, 700)).toBe(233);
  });

  it("returns 0 for zero tax rate", () => {
    expect(calculateTax(512500, 0)).toBe(0);
  });

  it("rejects negative subtotal", () => {
    expect(() => calculateTax(-100, 1000)).toThrow();
  });

  it("rejects non-integer basis points", () => {
    expect(() => calculateTax(10000, 10.5)).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// calculateTotal
// ─────────────────────────────────────────────────────────────────────────────

describe("calculateTotal", () => {
  it("adds subtotal and tax", () => {
    expect(calculateTotal(512500, 51250)).toBe(563750);
  });

  it("handles zero tax", () => {
    expect(calculateTotal(512500, 0)).toBe(512500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeInvoiceTotals (full pipeline)
// ─────────────────────────────────────────────────────────────────────────────

describe("computeInvoiceTotals", () => {
  it("computes all fields for a two-item invoice with 10% tax", () => {
    const result = computeInvoiceTotals(
      [
        { quantity: 20, unitPriceMinorUnits: 15000 }, // $300.00 × 1 = $300.00 → 20 × $150 = $3000
        { quantity: 15, unitPriceMinorUnits: 17500 }, // 15 × $175.00 = $2,625
      ],
      1000 // 10%
    );

    expect(result.lineItemTotals).toEqual([300000, 262500]);
    expect(result.subtotalMinorUnits).toBe(562500); // $5,625.00
    expect(result.taxMinorUnits).toBe(56250);         // $562.50
    expect(result.totalMinorUnits).toBe(618750);      // $6,187.50
  });

  it("computes correctly with no tax", () => {
    const result = computeInvoiceTotals(
      [{ quantity: 1, unitPriceMinorUnits: 25000 }],
      0
    );

    expect(result.lineItemTotals).toEqual([25000]);
    expect(result.subtotalMinorUnits).toBe(25000);
    expect(result.taxMinorUnits).toBe(0);
    expect(result.totalMinorUnits).toBe(25000);
  });

  it("is deterministic — same inputs always produce same output", () => {
    const items = [
      { quantity: 3, unitPriceMinorUnits: 9999 },
      { quantity: 7, unitPriceMinorUnits: 12345 },
    ];
    const result1 = computeInvoiceTotals(items, 825); // 8.25%
    const result2 = computeInvoiceTotals(items, 825);

    expect(result1).toEqual(result2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatMoney (display-only, never for calculation)
// ─────────────────────────────────────────────────────────────────────────────

describe("formatMoney", () => {
  it("formats USD minor units to dollar display", () => {
    expect(formatMoney(1250, "USD")).toBe("$12.50");
  });

  it("formats zero correctly", () => {
    expect(formatMoney(0, "USD")).toBe("$0.00");
  });

  it("formats large amounts", () => {
    expect(formatMoney(999999999, "USD")).toBe("$9,999,999.99");
  });

  it("rejects non-integer input", () => {
    expect(() => formatMoney(12.5, "USD")).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseMoneyToMinorUnits
// ─────────────────────────────────────────────────────────────────────────────

describe("parseMoneyToMinorUnits", () => {
  it("parses '12.50' to 1250", () => {
    expect(parseMoneyToMinorUnits("12.50")).toBe(1250);
  });

  it("parses '$12.50' to 1250", () => {
    expect(parseMoneyToMinorUnits("$12.50")).toBe(1250);
  });

  it("parses '1,500.00' to 150000", () => {
    expect(parseMoneyToMinorUnits("1,500.00")).toBe(150000);
  });

  it("returns null for invalid input", () => {
    expect(parseMoneyToMinorUnits("abc")).toBeNull();
    expect(parseMoneyToMinorUnits("-50.00")).toBeNull();
  });

  it("handles whole numbers", () => {
    expect(parseMoneyToMinorUnits("100")).toBe(10000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isValidCurrencyCode
// ─────────────────────────────────────────────────────────────────────────────

describe("isValidCurrencyCode", () => {
  it("accepts valid ISO 4217 codes", () => {
    expect(isValidCurrencyCode("USD")).toBe(true);
    expect(isValidCurrencyCode("EUR")).toBe(true);
    expect(isValidCurrencyCode("GBP")).toBe(true);
  });

  it("rejects lowercase", () => {
    expect(isValidCurrencyCode("usd")).toBe(false);
  });

  it("rejects wrong length", () => {
    expect(isValidCurrencyCode("US")).toBe(false);
    expect(isValidCurrencyCode("USDD")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// minorUnitsToDecimalString
// ─────────────────────────────────────────────────────────────────────────────

describe("minorUnitsToDecimalString", () => {
  it("converts typical dollar and cent amounts", () => {
    expect(minorUnitsToDecimalString(15000)).toBe("150.00");
    expect(minorUnitsToDecimalString(1250)).toBe("12.50");
    expect(minorUnitsToDecimalString(99)).toBe("0.99");
    expect(minorUnitsToDecimalString(5)).toBe("0.05");
    expect(minorUnitsToDecimalString(0)).toBe("0.00");
  });

  it("converts negative minor units", () => {
    expect(minorUnitsToDecimalString(-500)).toBe("-5.00");
    expect(minorUnitsToDecimalString(-5)).toBe("-0.05");
  });

  it("converts large values without floating point distortion", () => {
    expect(minorUnitsToDecimalString(100000000)).toBe("1000000.00");
  });

  it("throws error for non-integer inputs", () => {
    expect(() => minorUnitsToDecimalString(12.5)).toThrow();
    expect(() => minorUnitsToDecimalString(NaN)).toThrow();
  });
});
