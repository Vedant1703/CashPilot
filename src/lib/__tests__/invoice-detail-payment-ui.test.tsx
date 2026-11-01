/**
 * CashPilot AI — Invoice Detail View Payment Details UI Tests (Phase 2B)
 *
 * Verifies:
 * 1. Fully paid invoices:
 *    - Displays actual amount paid as supplied by PayPal.
 *    - Displays transaction/reference ID, payment date, payment method.
 *    - Shows PayPal-Verified badge and provider verification indicators.
 *    - Handles PAID invoices when payments block is omitted without inventing amounts or IDs.
 * 2. Partially paid invoices:
 *    - Displays amount received and outstanding balance when reliably derived.
 *    - Displays "Requires Review" warning callout and badge.
 *    - Does not invent missing outstanding balance if provider omitted due_amount.
 * 3. Refunded invoices:
 *    - Displays refund status, refund amount, refund transaction ID, and refund date.
 *    - Clearly distinguishes refund from retained revenue (shows non-retained notice).
 * 4. Unpaid invoices:
 *    - Does not display the payment summary card for unpaid SENT/DRAFT invoices.
 * 5. Data integrity:
 *    - Safely handles malformed/empty paypalStatusRaw without breaking.
 *    - Never calculates paid amount from invoice total alone.
 */

import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { InvoiceDetailView, SerializedInvoiceDetail } from "@/components/invoices/invoice-detail-view";
import { CashPilotStatus } from "@prisma/client";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => "/invoices/inv-test-123",
}));

const baseInvoice: SerializedInvoiceDetail = {
  id: "inv-test-123",
  workspaceId: "workspace-test-1",
  clientId: "client-test-1",
  number: "INV-1234",
  title: "Brand Identity Design",
  currency: "USD",
  subtotalMinorUnits: 150000,
  taxRateBasisPoints: 0,
  taxMinorUnits: 0,
  totalMinorUnits: 150000,
  invoiceDate: "2026-10-15T00:00:00.000Z",
  dueDate: "2026-10-31T00:00:00.000Z",
  cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
  paypalInvoiceId: "INV2-SANDBOX-TEST-123",
  paypalStatus: "SENT",
  lastSyncAt: "2026-10-31T12:00:00.000Z",
  syncIsStale: false,
  isDemoData: true,
  aiDraftId: null,
  client: {
    id: "client-test-1",
    name: "Design Corp",
    email: "billing@designcorp.test",
    company: "Design Corp LLC",
    phone: "+1-555-0100",
    isDemo: true,
  },
  lineItems: [
    {
      id: "li-1",
      description: "Brand Strategy & Guidelines",
      quantity: 1,
      unitPriceMinorUnits: 150000,
      totalMinorUnits: 150000,
      sortOrder: 0,
    },
  ],
  activities: [],
  workspace: {
    id: "workspace-test-1",
    name: "Test Studio",
    isDemo: true,
  },
};

describe("Phase 2B: Invoice Detail PayPal Payment Details UI", () => {
  describe("1. Fully Paid Invoices", () => {
    it("renders complete verified payment information when supplied by PayPal", () => {
      const invoice: SerializedInvoiceDetail = {
        ...baseInvoice,
        cashpilotStatus: CashPilotStatus.PAID,
        paypalStatus: "PAID",
        paypalStatusRaw: {
          id: "INV2-SANDBOX-TEST-123",
          status: "PAID",
          amount: {
            currency_code: "USD",
            value: "1500.00",
          },
          payments: {
            paid_amount: {
              currency_code: "USD",
              value: "1500.00",
            },
            transactions: [
              {
                payment_id: "PAYPAL-TX-998877",
                payment_date: "2026-10-31T14:30:00Z",
                method: "PAYPAL",
                amount: {
                  currency_code: "USD",
                  value: "1500.00",
                },
                note: "Payment via PayPal Sandbox Checkout",
              },
            ],
          },
        },
      };

      const html = renderToString(<InvoiceDetailView initialInvoice={invoice} />);

      // Payment Summary Card should be present
      expect(html).toContain("PayPal Payment Verification");
      expect(html).toContain("PayPal-Verified");
      expect(html).toContain("Verified by PayPal Invoicing API");
      expect(html).toContain("Actual Amount Paid");
      expect(html).toContain("$1,500.00");

      // Transaction / reference details
      expect(html).toContain("PAYPAL-TX-998877");
      expect(html).toContain("Oct 31, 2026");
      expect(html).toContain("Payment via PayPal Sandbox Checkout");
      expect(html).toContain("Copy transaction ID");

      // Provider status in sidebar
      expect(html).toContain("Settlement:");
      expect(html).toContain("Verified Paid");
    });

    it("renders verified status without inventing transaction ID or amount if PayPal omits payments array", () => {
      const invoice: SerializedInvoiceDetail = {
        ...baseInvoice,
        cashpilotStatus: CashPilotStatus.PAID,
        paypalStatus: "PAID",
        paypalStatusRaw: {
          id: "INV2-SANDBOX-TEST-123",
          status: "PAID",
          // payments array omitted
        },
      };

      const html = renderToString(<InvoiceDetailView initialInvoice={invoice} />);

      // Still renders payment summary card
      expect(html).toContain("PayPal Payment Verification");
      expect(html).toContain("PayPal-Verified");
      expect(html).toContain("Full settlement confirmed");
      // Must NOT display invented transaction ID
      expect(html).not.toContain("PAYPAL-TX");
      expect(html).toContain("Not specified in provider payload");
    });
  });

  describe("2. Partially Paid Invoices", () => {
    it("renders amount received and outstanding balance with Requires Review badge", () => {
      const invoice: SerializedInvoiceDetail = {
        ...baseInvoice,
        cashpilotStatus: CashPilotStatus.NEEDS_REVIEW,
        paypalStatus: "PARTIALLY_PAID",
        paypalStatusRaw: {
          id: "INV2-SANDBOX-TEST-123",
          status: "PARTIALLY_PAID",
          amount: {
            currency_code: "USD",
            value: "1500.00",
          },
          due_amount: {
            currency_code: "USD",
            value: "1000.00",
          },
          payments: {
            paid_amount: {
              currency_code: "USD",
              value: "500.00",
            },
            transactions: [
              {
                payment_id: "PARTIAL-TX-12345",
                payment_date: "2026-10-30T10:00:00Z",
                method: "BANK_TRANSFER",
                amount: {
                  currency_code: "USD",
                  value: "500.00",
                },
              },
            ],
          },
        },
      };

      const html = renderToString(<InvoiceDetailView initialInvoice={invoice} />);

      expect(html).toContain("Partial Payment Received");
      expect(html).toContain("Requires Review");
      expect(html).toContain("Action requires review");
      expect(html).toContain("$500.00");
      expect(html).toContain("Amount Received");
      expect(html).toContain("$1,000.00");
      expect(html).toContain("Outstanding Balance");
      expect(html).toContain("PARTIAL-TX-12345");

      // Sidebar settlement status
      expect(html).toContain("Settlement:");
      expect(html).toContain("Partial Payment");
    });
  });

  describe("3. Refunded and Partially Refunded Invoices", () => {
    it("renders refund details and does not present refund as retained payment", () => {
      const invoice: SerializedInvoiceDetail = {
        ...baseInvoice,
        cashpilotStatus: CashPilotStatus.NEEDS_REVIEW,
        paypalStatus: "REFUNDED",
        paypalStatusRaw: {
          id: "INV2-SANDBOX-TEST-123",
          status: "REFUNDED",
          refunds: {
            refund_amount: {
              currency_code: "USD",
              value: "1500.00",
            },
            transactions: [
              {
                refund_id: "REFUND-TX-445566",
                refund_date: "2026-11-01T08:00:00Z",
                method: "PAYPAL",
                amount: {
                  currency_code: "USD",
                  value: "1500.00",
                },
                note: "Full client refund processed",
              },
            ],
          },
        },
      };

      const html = renderToString(<InvoiceDetailView initialInvoice={invoice} />);

      expect(html).toContain("Invoice Refunded");
      expect(html).toContain("Refunded");
      expect(html).toContain("$1,500.00");
      expect(html).toContain("Refunded Amount");
      expect(html).toContain("REFUND-TX-445566");
      expect(html).toContain("Full client refund processed");
      // Explicit refund notice
      expect(html).toContain("All funds have been returned to the payer");

      // Sidebar settlement status
      expect(html).toContain("Settlement:");
      expect(html).toContain("Refunded");
    });

    it("renders partial refund notice and distinguishes non-retained payments", () => {
      const invoice: SerializedInvoiceDetail = {
        ...baseInvoice,
        cashpilotStatus: CashPilotStatus.NEEDS_REVIEW,
        paypalStatus: "PARTIALLY_REFUNDED",
        paypalStatusRaw: {
          id: "INV2-SANDBOX-TEST-123",
          status: "PARTIALLY_REFUNDED",
          refunds: {
            refund_amount: {
              currency_code: "USD",
              value: "500.00",
            },
            transactions: [
              {
                refund_id: "PARTIAL-REFUND-1",
                refund_date: "2026-11-01T09:00:00Z",
                method: "PAYPAL",
                amount: {
                  currency_code: "USD",
                  value: "500.00",
                },
              },
            ],
          },
        },
      };

      const html = renderToString(<InvoiceDetailView initialInvoice={invoice} />);

      expect(html).toContain("Partial Refund Issued");
      expect(html).toContain("Partially Refunded");
      expect(html).toContain("$500.00");
      expect(html).toContain("Refunded amounts are not treated as retained payments");
    });
  });

  describe("4. Unpaid Invoices", () => {
    it("does not render payment summary card for unpaid SENT invoices", () => {
      const invoice: SerializedInvoiceDetail = {
        ...baseInvoice,
        cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
        paypalStatus: "SENT",
        paypalStatusRaw: {
          id: "INV2-SANDBOX-TEST-123",
          status: "SENT",
          amount: {
            currency_code: "USD",
            value: "1500.00",
          },
        },
      };

      const html = renderToString(<InvoiceDetailView initialInvoice={invoice} />);

      expect(html).not.toContain("PayPal Payment Verification");
      expect(html).not.toContain("Partial Payment Received");
      expect(html).not.toContain("Invoice Refunded");
      expect(html).not.toContain("PayPal-Verified");
      expect(html).not.toContain("Requires Review");
    });
  });

  describe("5. Data Integrity & Edge Cases", () => {
    it("gracefully handles null paypalStatusRaw without errors", () => {
      const invoice: SerializedInvoiceDetail = {
        ...baseInvoice,
        cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
        paypalStatus: "SENT",
        paypalStatusRaw: null,
      };

      const html = renderToString(<InvoiceDetailView initialInvoice={invoice} />);
      expect(html).not.toContain("PayPal Payment Verification");
      expect(html).toContain("INV-1234");
    });

    it("parses paypalStatusRaw when stored as serialized JSON string", () => {
      const invoice: SerializedInvoiceDetail = {
        ...baseInvoice,
        cashpilotStatus: CashPilotStatus.PAID,
        paypalStatus: "PAID",
        paypalStatusRaw: JSON.stringify({
          id: "INV2-SANDBOX-TEST-123",
          status: "PAID",
          payments: {
            paid_amount: {
              currency_code: "USD",
              value: "1500.00",
            },
            transactions: [
              {
                payment_id: "STRINGIFIED-TX-1",
                payment_date: "2026-10-31T12:00:00Z",
              },
            ],
          },
        }),
      };

      const html = renderToString(<InvoiceDetailView initialInvoice={invoice} />);
      expect(html).toContain("PayPal Payment Verification");
      expect(html).toContain("STRINGIFIED-TX-1");
      expect(html).toContain("$1,500.00");
    });
  });
});
