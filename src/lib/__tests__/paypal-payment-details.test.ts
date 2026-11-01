/**
 * CashPilot AI — PayPal Payment Details Unit Tests
 *
 * Tests extraction, validation, and safe formatting of PayPal payment data
 * from `paypalStatusRaw` responses according to Phase 2B requirements.
 */

import { describe, it, expect } from "vitest";
import {
  extractPayPalPaymentDetails,
  formatPayPalAmount,
  formatPayPalDate,
} from "@/lib/paypal/payment-details";

describe("PayPal Payment Details (payment-details.ts)", () => {
  describe("formatPayPalAmount", () => {
    it("formats decimal string with currency using integer minor units", () => {
      expect(formatPayPalAmount("120.00", "USD")).toBe("$120.00 USD");
      expect(formatPayPalAmount("1500.50", "USD")).toBe("$1,500.50 USD");
      expect(formatPayPalAmount("0.00", "USD")).toBe("$0.00 USD");
      expect(formatPayPalAmount("75.25", "EUR")).toBe("€75.25 EUR");
      expect(formatPayPalAmount("100.00", "GBP")).toBe("£100.00 GBP");
      expect(formatPayPalAmount("5000.00", "INR")).toBe("₹5,000.00 INR");
    });

    it("returns null for missing, empty, or unparseable amounts", () => {
      expect(formatPayPalAmount(null, "USD")).toBeNull();
      expect(formatPayPalAmount(undefined, "USD")).toBeNull();
      expect(formatPayPalAmount("", "USD")).toBeNull();
      expect(formatPayPalAmount("not-a-number", "USD")).toBeNull();
    });
  });

  describe("formatPayPalDate", () => {
    it("formats ISO 8601 strings", () => {
      const formatted = formatPayPalDate("2026-10-31T15:30:00Z");
      expect(formatted).not.toBeNull();
      expect(formatted).toContain("2026");
      expect(formatted).toContain("Oct");
    });

    it("formats date-only strings consistently in UTC", () => {
      const formatted = formatPayPalDate("2026-10-31");
      expect(formatted).toBe("Oct 31, 2026");
    });

    it("handles PayPal timestamp strings with timezone names", () => {
      const formatted = formatPayPalDate("2026-10-31 08:30:00 PST");
      expect(formatted).not.toBeNull();
      expect(typeof formatted).toBe("string");
    });

    it("returns null for missing or empty dates", () => {
      expect(formatPayPalDate(null)).toBeNull();
      expect(formatPayPalDate(undefined)).toBeNull();
      expect(formatPayPalDate("")).toBeNull();
      expect(formatPayPalDate("   ")).toBeNull();
    });
  });

  describe("extractPayPalPaymentDetails — Fully Paid Invoices", () => {
    it("extracts complete payment details when supplied by PayPal", () => {
      const rawPayload = {
        id: "INV2-PAID-001",
        status: "PAID",
        detail: {
          currency_code: "USD",
        },
        amount: {
          currency_code: "USD",
          value: "1200.00",
        },
        due_amount: {
          currency_code: "USD",
          value: "0.00",
        },
        payments: {
          paid_amount: {
            currency_code: "USD",
            value: "1200.00",
          },
          transactions: [
            {
              type: "PAYPAL",
              payment_id: "CAPTURE-PAYPAL-9876",
              payment_date: "2026-10-31T14:20:00Z",
              method: "PAYPAL",
              amount: {
                currency_code: "USD",
                value: "1200.00",
              },
              note: "Invoice payment received",
            },
          ],
        },
      };

      const summary = extractPayPalPaymentDetails(rawPayload, "PAID", "USD");

      expect(summary.isPaid).toBe(true);
      expect(summary.isPayPalVerified).toBe(true);
      expect(summary.requiresReview).toBe(false);
      expect(summary.hasPaymentData).toBe(true);
      expect(summary.rawStatus).toBe("PAID");

      // Actual amount paid
      expect(summary.paidAmountFormatted).toBe("$1,200.00 USD");
      expect(summary.paidAmountValue).toBe("1200.00");
      expect(summary.paidAmountCurrency).toBe("USD");

      // Transaction reference and payment date
      expect(summary.primaryTransactionId).toBe("CAPTURE-PAYPAL-9876");
      expect(summary.primaryPaymentDate).not.toBeNull();
      expect(summary.primaryPaymentMethod).toBe("PAYPAL");

      // Transaction array
      expect(summary.paymentTransactions.length).toBe(1);
      expect(summary.paymentTransactions[0].id).toBe("CAPTURE-PAYPAL-9876");
      expect(summary.paymentTransactions[0].amountFormatted).toBe("$1,200.00 USD");
    });

    it("handles PAID status when payments block is omitted without inventing amounts or transaction IDs", () => {
      // E.g. marked as paid or provider returned status without payments sub-object
      const rawPayload = {
        id: "INV2-PAID-NO-PAYMENTS",
        status: "PAID",
      };

      const summary = extractPayPalPaymentDetails(rawPayload, "PAID", "USD");

      expect(summary.isPaid).toBe(true);
      expect(summary.isPayPalVerified).toBe(true);
      expect(summary.requiresReview).toBe(false);
      expect(summary.hasPaymentData).toBe(true);

      // Financial invariant: Never invent amounts or transaction IDs
      expect(summary.paidAmountFormatted).toBeNull();
      expect(summary.paidAmountValue).toBeNull();
      expect(summary.primaryTransactionId).toBeNull();
      expect(summary.primaryPaymentDate).toBeNull();
      expect(summary.paymentTransactions.length).toBe(0);
    });
  });

  describe("extractPayPalPaymentDetails — Partially Paid Invoices", () => {
    it("extracts amount received and outstanding balance when both are reliably present", () => {
      const rawPayload = {
        id: "INV2-PARTIAL-001",
        status: "PARTIALLY_PAID",
        amount: {
          currency_code: "USD",
          value: "1000.00",
        },
        due_amount: {
          currency_code: "USD",
          value: "600.00",
        },
        payments: {
          paid_amount: {
            currency_code: "USD",
            value: "400.00",
          },
          transactions: [
            {
              type: "PAYPAL",
              payment_id: "PARTIAL-TX-101",
              payment_date: "2026-10-30T10:00:00Z",
              method: "PAYPAL",
              amount: {
                currency_code: "USD",
                value: "400.00",
              },
            },
          ],
        },
      };

      const summary = extractPayPalPaymentDetails(rawPayload, "PARTIALLY_PAID", "USD");

      expect(summary.isPartiallyPaid).toBe(true);
      expect(summary.isPaid).toBe(false);
      expect(summary.requiresReview).toBe(true);
      expect(summary.hasPaymentData).toBe(true);

      // Amount received & outstanding balance
      expect(summary.paidAmountFormatted).toBe("$400.00 USD");
      expect(summary.dueAmountFormatted).toBe("$600.00 USD");
      expect(summary.primaryTransactionId).toBe("PARTIAL-TX-101");
    });

    it("does not calculate missing outstanding balance when provider omits due_amount", () => {
      const rawPayload = {
        id: "INV2-PARTIAL-NO-DUE",
        status: "PARTIALLY_PAID",
        payments: {
          paid_amount: {
            currency_code: "USD",
            value: "350.00",
          },
        },
      };

      const summary = extractPayPalPaymentDetails(rawPayload, "PARTIALLY_PAID", "USD");

      expect(summary.isPartiallyPaid).toBe(true);
      expect(summary.requiresReview).toBe(true);
      expect(summary.paidAmountFormatted).toBe("$350.00 USD");

      // Invariant: Never guess or calculate balance without provider data
      expect(summary.dueAmountFormatted).toBeNull();
    });
  });

  describe("extractPayPalPaymentDetails — Refunded Invoices", () => {
    it("extracts refund status and details without presenting refunds as retained payments", () => {
      const rawPayload = {
        id: "INV2-REFUND-001",
        status: "REFUNDED",
        refunds: {
          refund_amount: {
            currency_code: "USD",
            value: "800.00",
          },
          transactions: [
            {
              type: "PAYPAL",
              refund_id: "REF-TX-8888",
              refund_date: "2026-10-31",
              method: "PAYPAL",
              amount: {
                currency_code: "USD",
                value: "800.00",
              },
              note: "Customer cancellation refund",
            },
          ],
        },
      };

      const summary = extractPayPalPaymentDetails(rawPayload, "REFUNDED", "USD");

      expect(summary.isRefunded).toBe(true);
      expect(summary.isPartiallyRefunded).toBe(false);
      expect(summary.requiresReview).toBe(true);
      expect(summary.hasPaymentData).toBe(true);

      // Refunded amount
      expect(summary.refundedAmountFormatted).toBe("$800.00 USD");
      expect(summary.refundTransactions.length).toBe(1);
      expect(summary.refundTransactions[0].id).toBe("REF-TX-8888");
      expect(summary.refundTransactions[0].note).toBe("Customer cancellation refund");

      // Invariant: Do not present refunded amounts as successfully retained payments
      expect(summary.paidAmountFormatted).toBeNull();
    });

    it("distinguishes partially refunded invoices", () => {
      const rawPayload = {
        id: "INV2-PARTIAL-REFUND-001",
        status: "PARTIALLY_REFUNDED",
        refunds: {
          refund_amount: {
            currency_code: "USD",
            value: "250.00",
          },
        },
      };

      const summary = extractPayPalPaymentDetails(rawPayload, "PARTIALLY_REFUNDED", "USD");

      expect(summary.isPartiallyRefunded).toBe(true);
      expect(summary.isRefunded).toBe(false);
      expect(summary.requiresReview).toBe(true);
      expect(summary.refundedAmountFormatted).toBe("$250.00 USD");
    });
  });

  describe("extractPayPalPaymentDetails — Unpaid and Edge Cases", () => {
    it("returns hasPaymentData false for unpaid SENT invoices", () => {
      const rawPayload = {
        id: "INV2-SENT-001",
        status: "SENT",
      };

      const summary = extractPayPalPaymentDetails(rawPayload, "SENT", "USD");

      expect(summary.hasPaymentData).toBe(false);
      expect(summary.isPaid).toBe(false);
      expect(summary.isPartiallyPaid).toBe(false);
      expect(summary.isRefunded).toBe(false);
      expect(summary.paidAmountFormatted).toBeNull();
    });

    it("safely handles null, undefined, or empty payload", () => {
      const summaryNull = extractPayPalPaymentDetails(null, "SENT", "USD");
      expect(summaryNull.hasPaymentData).toBe(false);
      expect(summaryNull.isPaid).toBe(false);

      const summaryEmpty = extractPayPalPaymentDetails({}, "DRAFT", "USD");
      expect(summaryEmpty.hasPaymentData).toBe(false);
      expect(summaryEmpty.isPaid).toBe(false);
    });

    it("parses valid JSON string representation of paypalStatusRaw", () => {
      const jsonStr = JSON.stringify({
        id: "INV2-STRINGIFIED",
        status: "PAID",
        payments: {
          paid_amount: { currency_code: "USD", value: "500.00" },
        },
      });

      const summary = extractPayPalPaymentDetails(jsonStr, "PAID", "USD");
      expect(summary.isPaid).toBe(true);
      expect(summary.paidAmountFormatted).toBe("$500.00 USD");
    });
  });
});
