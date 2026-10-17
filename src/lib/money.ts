/**
 * CashPilot AI — Money Utilities
 *
 * Financial integrity rules (SRS §3, AGENTS.md §4):
 *   - Never use JavaScript floating-point arithmetic for monetary values
 *   - Store and pass amounts as integer minor units (e.g., cents for USD)
 *   - Always retain currency alongside monetary values
 *   - All calculations go through these functions; never inline arithmetic
 *
 * Design decisions:
 *   - Minor units = smallest denomination of a currency (cents, pence, etc.)
 *   - For USD: 1 USD = 100 cents → $12.50 = 1250 minor units
 *   - taxRateBasisPoints: 100 basis points = 1 percentage point
 *     → 10% tax = 1000 basis points
 */

/** Multiply two integers safely — guards against accidental float inputs */
function safeIntMultiply(a: number, b: number): number {
  if (!Number.isInteger(a) || !Number.isInteger(b)) {
    throw new Error(
      `Money calculation error: expected integers, got ${a} (${typeof a}) * ${b} (${typeof b})`
    );
  }
  return a * b;
}

/**
 * Calculate a single line item total.
 * Both quantity and unitPriceMinorUnits must be integers.
 */
export function calculateLineItemTotal(
  quantity: number,
  unitPriceMinorUnits: number
): number {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new Error(`Invalid quantity: ${quantity}. Must be a non-negative integer.`);
  }
  if (!Number.isInteger(unitPriceMinorUnits) || unitPriceMinorUnits < 0) {
    throw new Error(
      `Invalid unit price: ${unitPriceMinorUnits}. Must be a non-negative integer (minor units).`
    );
  }
  return safeIntMultiply(quantity, unitPriceMinorUnits);
}

/**
 * Calculate invoice subtotal from line items.
 * All line item totals must be integer minor units.
 */
export function calculateSubtotal(
  lineItemTotals: number[]
): number {
  for (const t of lineItemTotals) {
    if (!Number.isInteger(t) || t < 0) {
      throw new Error(
        `Invalid line item total: ${t}. All totals must be non-negative integers (minor units).`
      );
    }
  }
  return lineItemTotals.reduce((sum, t) => sum + t, 0);
}

/**
 * Calculate tax as integer minor units.
 * taxRateBasisPoints: e.g., 1000 = 10.00%, 0 = no tax.
 *
 * Algorithm: Math.round(subtotal * taxRateBasisPoints / 10000)
 * This avoids floating-point errors by doing integer division with rounding.
 */
export function calculateTax(
  subtotalMinorUnits: number,
  taxRateBasisPoints: number
): number {
  if (!Number.isInteger(subtotalMinorUnits) || subtotalMinorUnits < 0) {
    throw new Error(`Invalid subtotal: ${subtotalMinorUnits}`);
  }
  if (!Number.isInteger(taxRateBasisPoints) || taxRateBasisPoints < 0) {
    throw new Error(`Invalid tax rate (basis points): ${taxRateBasisPoints}`);
  }
  if (taxRateBasisPoints === 0) return 0;
  // Integer math: avoid floating point
  return Math.round((subtotalMinorUnits * taxRateBasisPoints) / 10000);
}

/**
 * Calculate invoice total = subtotal + tax.
 */
export function calculateTotal(
  subtotalMinorUnits: number,
  taxMinorUnits: number
): number {
  if (!Number.isInteger(subtotalMinorUnits) || subtotalMinorUnits < 0) {
    throw new Error(`Invalid subtotal: ${subtotalMinorUnits}`);
  }
  if (!Number.isInteger(taxMinorUnits) || taxMinorUnits < 0) {
    throw new Error(`Invalid tax: ${taxMinorUnits}`);
  }
  return subtotalMinorUnits + taxMinorUnits;
}

/**
 * Format integer minor units for display.
 * Example: formatMoney(1250, "USD") → "$12.50"
 *
 * Uses the Intl.NumberFormat API for locale-correct display.
 * This is display-only; never use for calculations.
 */
export function formatMoney(minorUnits: number, currency: string): string {
  if (!Number.isInteger(minorUnits)) {
    throw new Error(`Cannot format non-integer minor units: ${minorUnits}`);
  }
  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  });
  // Divide by 100 for display only — this is the ONLY place we do this
  return formatter.format(minorUnits / 100);
}

/**
 * Parse a display string like "$12.50" or "12.50" into minor units.
 * Use for user-entered amounts. Returns null if parsing fails.
 */
export function parseMoneyToMinorUnits(
  displayValue: string
): number | null {
  // Strip currency symbols, spaces, commas
  const cleaned = displayValue.replace(/[$£€,\s]/g, "").trim();
  const parsed = parseFloat(cleaned);
  if (isNaN(parsed) || parsed < 0) return null;
  // Round to avoid floating point: multiply by 100, round to integer
  return Math.round(parsed * 100);
}

/**
 * Validate a currency code (basic ISO 4217 format check).
 */
export function isValidCurrencyCode(currency: string): boolean {
  return /^[A-Z]{3}$/.test(currency);
}

/**
 * Compute all invoice money fields deterministically.
 * This is the single authoritative calculation path for invoice totals.
 */
export function computeInvoiceTotals(
  lineItems: Array<{ quantity: number; unitPriceMinorUnits: number }>,
  taxRateBasisPoints: number
): {
  lineItemTotals: number[];
  subtotalMinorUnits: number;
  taxMinorUnits: number;
  totalMinorUnits: number;
} {
  const lineItemTotals = lineItems.map((li) =>
    calculateLineItemTotal(li.quantity, li.unitPriceMinorUnits)
  );
  const subtotalMinorUnits = calculateSubtotal(lineItemTotals);
  const taxMinorUnits = calculateTax(subtotalMinorUnits, taxRateBasisPoints);
  const totalMinorUnits = calculateTotal(subtotalMinorUnits, taxMinorUnits);

  return { lineItemTotals, subtotalMinorUnits, taxMinorUnits, totalMinorUnits };
}
