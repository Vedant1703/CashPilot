/**
 * CashPilot AI — Reconciliation Modal Component Tests
 *
 * UI Reference Page 14 & Demo Step 9:
 * Tests the interactive status reconciliation modal:
 * - Does not render when isOpen = false
 * - Renders 5-step progress indicator (Ask PayPal -> Check answer -> Match stage -> Save & log -> Update board)
 * - Renders summary state with before-and-after column deltas, itemized table, and financial integrity note
 */

import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { ReconciliationModal } from "@/components/collections/reconciliation-modal";
import { CashPilotStatus } from "@prisma/client";
import type { BatchSyncSummary } from "@/lib/services/invoice.service";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
  }),
}));

const mockSummary: BatchSyncSummary = {
  workspaceId: "demo-workspace-1",
  syncedAt: "2026-10-31T12:00:00.000Z",
  totalInvoicesScanned: 3,
  totalPaypalInvoicesQueried: 2,
  changedCount: 1,
  staleCount: 1,
  reconciledCount: 0,
  beforeStages: {
    draft: 1,
    awaitingPayment: 1,
    dueSoon: 0,
    overdue: 1,
    paid: 0,
    needsReview: 0,
    cancelled: 0,
  },
  afterStages: {
    draft: 1,
    awaitingPayment: 1,
    dueSoon: 0,
    overdue: 0,
    paid: 1,
    needsReview: 0,
    cancelled: 0,
  },
  beforeOutstandingMinorUnits: 350000,
  afterOutstandingMinorUnits: 200000,
  currency: "USD",
  items: [
    {
      invoiceId: "inv-1",
      number: "INV-0001",
      clientName: "Acme Corp",
      totalMinorUnits: 150000,
      currency: "USD",
      paypalInvoiceId: "PAYPAL-1",
      hasPaypalInvoice: true,
      previousPaypalStatus: "SENT",
      currentPaypalStatus: "PAID",
      previousCashpilotStatus: CashPilotStatus.OVERDUE,
      currentCashpilotStatus: CashPilotStatus.PAID,
      statusChanged: true,
      isStale: false,
      reconciledOperationsCount: 0,
      message: "Status updated: OVERDUE → PAID",
    },
    {
      invoiceId: "inv-2",
      number: "INV-0002",
      clientName: "TechStart Inc",
      totalMinorUnits: 200000,
      currency: "USD",
      paypalInvoiceId: "PAYPAL-2",
      hasPaypalInvoice: true,
      previousPaypalStatus: "SENT",
      currentPaypalStatus: "SENT",
      previousCashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
      currentCashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
      statusChanged: false,
      isStale: true,
      reconciledOperationsCount: 0,
      message: "PayPal sync failed: Timeout. Preserved last known status.",
    },
    {
      invoiceId: "inv-3",
      number: "INV-0003",
      clientName: "Jane Smith",
      totalMinorUnits: 50000,
      currency: "USD",
      paypalInvoiceId: null,
      hasPaypalInvoice: false,
      previousPaypalStatus: null,
      currentPaypalStatus: null,
      previousCashpilotStatus: CashPilotStatus.DRAFT,
      currentCashpilotStatus: CashPilotStatus.DRAFT,
      statusChanged: false,
      isStale: false,
      reconciledOperationsCount: 0,
      message: "Local draft — not dispatched to PayPal",
    },
  ],
};

describe("ReconciliationModal Component (UI Reference Page 14)", () => {
  it("returns null when isOpen is false", () => {
    const html = renderToString(
      <ReconciliationModal isOpen={false} onClose={() => {}} />
    );
    expect(html).toBe("");
  });

  it("renders modal structure, title, and 5-step process stepper when open", () => {
    const html = renderToString(
      <ReconciliationModal isOpen={true} onClose={() => {}} />
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain("Reconcile Receivables with PayPal");
    expect(html).toContain("Verified by PayPal Sandbox");

    // 5-step stepper labels
    expect(html).toContain("1 Ask PayPal");
    expect(html).toContain("2 Check answer");
    expect(html).toContain("3 Match stage");
    expect(html).toContain("4 Save &amp; log");
    expect(html).toContain("5 Update board");
  });

  it("renders full reconciliation summary with board column changes, itemized table, and financial invariant note", () => {
    const html = renderToString(
      <ReconciliationModal
        isOpen={true}
        onClose={() => {}}
        initialSummary={mockSummary}
      />
    );

    // Delta metric cards
    expect(html).toContain("Invoices Checked");
    expect(html).toContain("Status Updates");
    expect(html).toContain("Outstanding Delta");

    // Board column changes
    expect(html).toContain("Board Column Changes");
    expect(html).toContain("Draft");
    expect(html).toContain("Overdue");
    expect(html).toContain("Paid");

    // Itemized table details
    expect(html).toContain("INV-0001");
    expect(html).toContain("Acme Corp");
    expect(html).toContain("INV-0002");
    expect(html).toContain("TechStart Inc");
    expect(html).toContain("INV-0003");

    // Financial integrity guarantee
    expect(html).toContain("Financial Integrity Invariant");
    expect(html).toContain("Only verified provider evidence sets status to");
    expect(html).toContain("PAID");

    // Action button
    expect(html).toContain("Apply &amp; Update Board");
  });
});
