/**
 * CashPilot AI — Demo Payment Simulation UI Tests (Phase 3C)
 *
 * Verifies:
 * 1. SimulatePaymentModal presentation:
 *    - Explicit warnings: "SIMULATED · NO REAL MONEY MOVED".
 *    - Invariant guarantees: zero PayPal calls, locked to authoritative invoice total.
 * 2. SimulatedPaymentSummaryCard presentation:
 *    - Only renders when simulated.
 *    - Shows prominent "SIMULATED — NO REAL MONEY MOVED" badge.
 *    - Shows simulated amount, reference, timestamp, and demo user actor.
 * 3. InvoiceDetailView integration:
 *    - "Simulate payment" button visible only for eligible invoices in Demo Workspace.
 *    - Non-demo workspace: button is strictly hidden.
 *    - Non-demo invoice: button is strictly hidden.
 *    - Paid, cancelled, or refunded invoices: button is strictly hidden.
 *    - Simulated invoices suppress reminder and cancel actions.
 */

import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import {
  InvoiceDetailView,
  SerializedInvoiceDetail,
} from "@/components/invoices/invoice-detail-view";
import { SimulatePaymentModal } from "@/components/invoices/simulate-payment-modal";
import { SimulatedPaymentSummaryCard } from "@/components/invoices/simulated-payment-summary-card";
import { CashPilotStatus } from "@prisma/client";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => "/invoices/inv-test-sim",
}));

describe("Phase 3C: Demo Payment Simulation UI Components", () => {
  const baseDemoInvoice: SerializedInvoiceDetail = {
    id: "inv-demo-123",
    workspaceId: "demo-workspace-1",
    clientId: "client-demo-1",
    number: "INV-DEMO-2026",
    title: "Quarterly Strategy Retainer",
    currency: "USD",
    subtotalMinorUnits: 150000,
    taxRateBasisPoints: 0,
    taxMinorUnits: 0,
    totalMinorUnits: 150000,
    invoiceDate: "2026-03-01T00:00:00.000Z",
    dueDate: "2026-03-15T00:00:00.000Z",
    cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
    paypalInvoiceId: "INV2-SANDBOX-DEMO",
    paypalStatus: "SENT",
    lastSyncAt: "2026-03-01T12:00:00.000Z",
    syncIsStale: false,
    isDemoData: true,
    paymentProvenance: "NONE",
    simulatedPaymentAt: null,
    simulatedAmountMinorUnits: null,
    simulatedRef: null,
    aiDraftId: null,
    client: {
      id: "client-demo-1",
      name: "Acme Creative Labs",
      email: "finance@acme.test",
      company: "Acme Labs",
      phone: null,
      isDemo: true,
    },
    lineItems: [
      {
        id: "li-1",
        description: "Brand Strategy Advisory",
        quantity: 1,
        unitPriceMinorUnits: 150000,
        totalMinorUnits: 150000,
        sortOrder: 0,
      },
    ],
    workspace: {
      id: "demo-workspace-1",
      name: "My Freelance Studio",
      isDemo: true,
    },
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. SimulatePaymentModal
  // ─────────────────────────────────────────────────────────────────────────────

  describe("SimulatePaymentModal", () => {
    it("renders modal with explicit simulation warnings and locked invoice totals", () => {
      const html = renderToString(
        <SimulatePaymentModal
          invoice={baseDemoInvoice}
          isOpen={true}
          onClose={vi.fn()}
          onSimulateSuccess={vi.fn()}
        />
      );

      // Title & Prominent Warning
      expect(html).toContain("Simulate Demo Payment");
      expect(html).toContain("SIMULATED — NO REAL MONEY MOVED");
      expect(html).toContain("Eligible Demo Workspace invoice completion");

      // Displays Authoritative Total
      expect(html).toContain("$1,500.00");
      expect(html).toContain("Acme Creative Labs");
      expect(html).toContain("INV-DEMO-2026");

      // Safety Invariants
      expect(html).toContain("Financial Integrity &amp; Safety Invariants");
      expect(html).toContain("No PayPal API calls will be made");
      expect(html).toContain("PayPal provider status is not fabricated");
    });

    it("does not render when isOpen is false", () => {
      const html = renderToString(
        <SimulatePaymentModal
          invoice={baseDemoInvoice}
          isOpen={false}
          onClose={vi.fn()}
          onSimulateSuccess={vi.fn()}
        />
      );

      expect(html).toBe("");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. SimulatedPaymentSummaryCard
  // ─────────────────────────────────────────────────────────────────────────────

  describe("SimulatedPaymentSummaryCard", () => {
    it("does not render for unsimulated invoices", () => {
      const html = renderToString(
        <SimulatedPaymentSummaryCard
          paymentProvenance="NONE"
          cashpilotStatus="AWAITING_PAYMENT"
          totalMinorUnits={150000}
          currency="USD"
        />
      );

      expect(html).toBe("");
    });

    it("renders simulated payment summary card with unmistakable labeling and metadata", () => {
      const html = renderToString(
        <SimulatedPaymentSummaryCard
          paymentProvenance="SIMULATED_DEMO_PAYMENT"
          cashpilotStatus="SIMULATED_PAID"
          simulatedAmountMinorUnits={150000}
          totalMinorUnits={150000}
          currency="USD"
          simulatedPaymentAt="2026-03-02T10:30:00.000Z"
          simulatedRef="SIM-DEMO-1234-ABCD"
        />
      );

      expect(html).toContain("Demo Payment Simulation");
      expect(html).toContain("SIMULATED — NO REAL MONEY MOVED");
      expect(html).toContain("$1,500.00");
      expect(html).toContain("SIM-DEMO-1234-ABCD");
      expect(html).toContain("Demo User");
      expect(html).toContain("Strict Separation of Provider and Workflow Status");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. InvoiceDetailView Action Button Visibility
  // ─────────────────────────────────────────────────────────────────────────────

  describe("InvoiceDetailView action controls", () => {
    it("displays 'Simulate payment' action button for eligible demo invoice in demo workspace", () => {
      const html = renderToString(
        <InvoiceDetailView initialInvoice={baseDemoInvoice} />
      );

      expect(html).toContain("Simulate payment");
    });

    it("strictly hides 'Simulate payment' button for non-demo customer workspace", () => {
      const nonDemoWorkspaceInvoice: SerializedInvoiceDetail = {
        ...baseDemoInvoice,
        workspaceId: "workspace-customer-1",
        workspace: {
          id: "workspace-customer-1",
          name: "Real Customer Studio",
          isDemo: false,
        },
      };

      const html = renderToString(
        <InvoiceDetailView initialInvoice={nonDemoWorkspaceInvoice} />
      );

      expect(html).not.toContain("Simulate payment");
    });

    it("strictly hides 'Simulate payment' button for non-demo invoice", () => {
      const nonDemoDataInvoice: SerializedInvoiceDetail = {
        ...baseDemoInvoice,
        isDemoData: false,
      };

      const html = renderToString(
        <InvoiceDetailView initialInvoice={nonDemoDataInvoice} />
      );

      expect(html).not.toContain("Simulate payment");
    });

    it("strictly hides 'Simulate payment' button for already PayPal-paid invoice", () => {
      const paidInvoice: SerializedInvoiceDetail = {
        ...baseDemoInvoice,
        cashpilotStatus: CashPilotStatus.PAID,
        paypalStatus: "PAID",
      };

      const html = renderToString(
        <InvoiceDetailView initialInvoice={paidInvoice} />
      );

      expect(html).not.toContain("Simulate payment");
    });

    it("strictly hides 'Simulate payment' button for cancelled invoice", () => {
      const cancelledInvoice: SerializedInvoiceDetail = {
        ...baseDemoInvoice,
        cashpilotStatus: CashPilotStatus.CANCELLED,
        paypalStatus: "CANCELLED",
      };

      const html = renderToString(
        <InvoiceDetailView initialInvoice={cancelledInvoice} />
      );

      expect(html).not.toContain("Simulate payment");
    });

    it("strictly hides 'Simulate payment' button for refunded invoice", () => {
      const refundedInvoice: SerializedInvoiceDetail = {
        ...baseDemoInvoice,
        paypalStatus: "REFUNDED",
      };

      const html = renderToString(
        <InvoiceDetailView initialInvoice={refundedInvoice} />
      );

      expect(html).not.toContain("Simulate payment");
    });

    it("strictly hides 'Simulate payment' button for partially paid invoice", () => {
      const partiallyPaidInvoice: SerializedInvoiceDetail = {
        ...baseDemoInvoice,
        paypalStatus: "PARTIALLY_PAID",
      };

      const html = renderToString(
        <InvoiceDetailView initialInvoice={partiallyPaidInvoice} />
      );

      expect(html).not.toContain("Simulate payment");
    });

    it("renders SimulatedPaymentSummaryCard and suppresses reminder/cancel buttons once simulated", () => {
      const simulatedInvoice: SerializedInvoiceDetail = {
        ...baseDemoInvoice,
        cashpilotStatus: CashPilotStatus.SIMULATED_PAID,
        paymentProvenance: "SIMULATED_DEMO_PAYMENT",
        simulatedPaymentAt: "2026-03-02T10:30:00.000Z",
        simulatedAmountMinorUnits: 150000,
        simulatedRef: "SIM-DEMO-TEST-REF",
      };

      const html = renderToString(
        <InvoiceDetailView initialInvoice={simulatedInvoice} />
      );

      // Simulation summary is displayed
      expect(html).toContain("SIMULATED — NO REAL MONEY MOVED");
      expect(html).toContain("SIM-DEMO-TEST-REF");

      // Remind and cancel buttons are suppressed
      expect(html).not.toContain("Send reminder");
      expect(html).not.toContain("Cancel invoice");
      // Simulate button is suppressed (already simulated)
      expect(html).not.toContain("Simulate payment");
    });
  });
});
