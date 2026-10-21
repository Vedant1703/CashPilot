import { describe, it, expect } from "vitest";
import { CashPilotStatus } from "@prisma/client";
import {
  calculateDashboardMetrics,
  groupInvoicesForCollections,
  getInvoiceProvenance,
  diffInDays,
  type InvoiceRecord,
} from "@/lib/dashboard/metrics";

describe("Dashboard & Collections Metrics Unit Tests", () => {
  // Fixed reference date: 2026-10-15T12:00:00Z
  const fixedNow = new Date("2026-10-15T12:00:00Z");

  const createInvoice = (overrides: Partial<InvoiceRecord>): InvoiceRecord => ({
    id: `inv-${Math.random().toString(36).slice(2, 7)}`,
    number: "INV-001",
    title: "Test Invoice",
    client: {
      name: "Acme Client",
      email: "acme@example.com",
    },
    currency: "USD",
    totalMinorUnits: 10000, // $100.00
    invoiceDate: "2026-10-01T00:00:00Z",
    dueDate: "2026-10-20T00:00:00Z",
    cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
    paypalStatus: "SENT",
    paypalInvoiceId: "PAYPAL-INV-1",
    isDemoData: false,
    syncIsStale: false,
    aiDraftId: null,
    updatedAt: "2026-10-01T00:00:00Z",
    lastSyncAt: "2026-10-15T10:00:00Z",
    notes: null,
    ...overrides,
  });

  describe("Date math utilities", () => {
    it("calculates difference in days deterministically", () => {
      const today = new Date("2026-10-15T00:00:00Z");
      const inThreeDays = new Date("2026-10-18T00:00:00Z");
      const fiveDaysAgo = new Date("2026-10-10T00:00:00Z");

      expect(diffInDays(inThreeDays, today)).toBe(3);
      expect(diffInDays(fiveDaysAgo, today)).toBe(-5);
      expect(diffInDays(today, today)).toBe(0);
    });
  });

  describe("calculateDashboardMetrics", () => {
    it("calculates outstanding total counting only sent, unpaid invoices", () => {
      const invoices: InvoiceRecord[] = [
        // Sent and unpaid (eligible)
        createInvoice({ id: "1", totalMinorUnits: 25000, cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT, dueDate: "2026-10-25T00:00:00Z" }),
        createInvoice({ id: "2", totalMinorUnits: 15000, cashpilotStatus: CashPilotStatus.DUE_SOON, dueDate: "2026-10-17T00:00:00Z" }),
        createInvoice({ id: "3", totalMinorUnits: 10000, cashpilotStatus: CashPilotStatus.OVERDUE, dueDate: "2026-10-05T00:00:00Z" }),

        // Ineligible: Draft (not sent)
        createInvoice({ id: "4", totalMinorUnits: 50000, cashpilotStatus: CashPilotStatus.DRAFT, paypalStatus: null }),

        // Ineligible: Cancelled
        createInvoice({ id: "5", totalMinorUnits: 30000, cashpilotStatus: CashPilotStatus.CANCELLED }),

        // Ineligible: Needs review
        createInvoice({ id: "6", totalMinorUnits: 20000, cashpilotStatus: CashPilotStatus.NEEDS_REVIEW }),

        // Ineligible: Paid
        createInvoice({ id: "7", totalMinorUnits: 40000, cashpilotStatus: CashPilotStatus.PAID, paypalStatus: "PAID" }),
      ];

      const metrics = calculateDashboardMetrics(invoices, fixedNow);

      // Expected outstanding: 25000 + 15000 + 10000 = 50000 ($500.00)
      expect(metrics.outstanding.amountMinorUnits).toBe(50000);
      expect(metrics.outstanding.formattedAmount).toBe("$500.00");
      expect(metrics.outstanding.count).toBe(3);
    });

    it("calculates overdue invoices with oldest days late", () => {
      const invoices: InvoiceRecord[] = [
        // Overdue by 10 days (2026-10-05 vs 2026-10-15)
        createInvoice({
          id: "1",
          totalMinorUnits: 15000,
          cashpilotStatus: CashPilotStatus.OVERDUE,
          dueDate: "2026-10-05T00:00:00Z",
          client: { name: "Late Client", email: "late@example.com" },
        }),
        // Overdue by 3 days (2026-10-12 vs 2026-10-15)
        createInvoice({
          id: "2",
          totalMinorUnits: 5000,
          cashpilotStatus: CashPilotStatus.OVERDUE,
          dueDate: "2026-10-12T00:00:00Z",
        }),
        // Not overdue (due in 5 days)
        createInvoice({
          id: "3",
          totalMinorUnits: 20000,
          cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
          dueDate: "2026-10-20T00:00:00Z",
        }),
      ];

      const metrics = calculateDashboardMetrics(invoices, fixedNow);

      expect(metrics.overdue.amountMinorUnits).toBe(20000);
      expect(metrics.overdue.formattedAmount).toBe("$200.00");
      expect(metrics.overdue.count).toBe(2);
      expect(metrics.overdue.contextText).toContain("oldest 10d late");
    });

    it("calculates due soon invoices strictly within 0-3 days window", () => {
      const invoices: InvoiceRecord[] = [
        // Due in 2 days (2026-10-17 vs 2026-10-15) -> Due soon
        createInvoice({
          id: "1",
          totalMinorUnits: 12000,
          cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
          dueDate: "2026-10-17T00:00:00Z",
        }),
        // Due today (2026-10-15) -> Due soon
        createInvoice({
          id: "2",
          totalMinorUnits: 8000,
          cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
          dueDate: "2026-10-15T00:00:00Z",
        }),
        // Due in 5 days (2026-10-20) -> Not due soon
        createInvoice({
          id: "3",
          totalMinorUnits: 30000,
          cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
          dueDate: "2026-10-20T00:00:00Z",
        }),
        // Overdue (2026-10-10) -> Not due soon
        createInvoice({
          id: "4",
          totalMinorUnits: 15000,
          cashpilotStatus: CashPilotStatus.OVERDUE,
          dueDate: "2026-10-10T00:00:00Z",
        }),
      ];

      const metrics = calculateDashboardMetrics(invoices, fixedNow);

      expect(metrics.dueSoon.amountMinorUnits).toBe(20000);
      expect(metrics.dueSoon.formattedAmount).toBe("$200.00");
      expect(metrics.dueSoon.count).toBe(2);
    });

    it("calculates paid this month and excludes previous month payments", () => {
      const invoices: InvoiceRecord[] = [
        // Paid in current month (October 2026)
        createInvoice({
          id: "1",
          totalMinorUnits: 35000,
          cashpilotStatus: CashPilotStatus.PAID,
          paypalStatus: "PAID",
          lastSyncAt: "2026-10-10T14:00:00Z",
        }),
        // Paid in previous month (September 2026)
        createInvoice({
          id: "2",
          totalMinorUnits: 50000,
          cashpilotStatus: CashPilotStatus.PAID,
          paypalStatus: "PAID",
          lastSyncAt: "2026-09-20T10:00:00Z",
        }),
        // Sent but NOT paid
        createInvoice({
          id: "3",
          totalMinorUnits: 25000,
          cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
          paypalStatus: "SENT",
        }),
      ];

      const metrics = calculateDashboardMetrics(invoices, fixedNow);

      expect(metrics.paidThisMonth.amountMinorUnits).toBe(35000);
      expect(metrics.paidThisMonth.formattedAmount).toBe("$350.00");
      expect(metrics.paidThisMonth.count).toBe(1);
    });

    it("never counts an invoice as paid merely because it was sent", () => {
      const invoices: InvoiceRecord[] = [
        createInvoice({
          id: "1",
          totalMinorUnits: 100000,
          cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT,
          paypalStatus: "SENT",
        }),
      ];

      const metrics = calculateDashboardMetrics(invoices, fixedNow);

      expect(metrics.paidThisMonth.amountMinorUnits).toBe(0);
      expect(metrics.paidThisMonth.count).toBe(0);
      expect(metrics.outstanding.amountMinorUnits).toBe(100000);
    });

    it("handles empty workspace with reassurance greeting and 0 balances", () => {
      const metrics = calculateDashboardMetrics([], fixedNow);

      expect(metrics.outstanding.amountMinorUnits).toBe(0);
      expect(metrics.outstanding.count).toBe(0);
      expect(metrics.overdue.amountMinorUnits).toBe(0);
      expect(metrics.dueSoon.amountMinorUnits).toBe(0);
      expect(metrics.paidThisMonth.amountMinorUnits).toBe(0);
      expect(metrics.naviGreeting.headline).toBe("No invoices yet.");
      expect(metrics.naviGreeting.body).toContain("Nothing is sent until you review and approve");
    });
  });

  describe("groupInvoicesForCollections", () => {
    it("partitions invoices into 5 primary Kanban columns and outside-board trays", () => {
      const invoices: InvoiceRecord[] = [
        createInvoice({ id: "draft-1", cashpilotStatus: CashPilotStatus.DRAFT }),
        createInvoice({ id: "awaiting-1", cashpilotStatus: CashPilotStatus.AWAITING_PAYMENT, dueDate: "2026-10-30T00:00:00Z" }),
        createInvoice({ id: "due-soon-1", cashpilotStatus: CashPilotStatus.DUE_SOON, dueDate: "2026-10-17T00:00:00Z" }),
        createInvoice({ id: "overdue-1", cashpilotStatus: CashPilotStatus.OVERDUE, dueDate: "2026-10-01T00:00:00Z" }),
        createInvoice({ id: "paid-1", cashpilotStatus: CashPilotStatus.PAID, paypalStatus: "PAID" }),
        createInvoice({ id: "review-1", cashpilotStatus: CashPilotStatus.NEEDS_REVIEW }),
        createInvoice({ id: "cancelled-1", cashpilotStatus: CashPilotStatus.CANCELLED }),
      ];

      const grouped = groupInvoicesForCollections(invoices, fixedNow);

      // Primary Kanban columns
      expect(grouped.columns.draft).toHaveLength(1);
      expect(grouped.columns.draft[0].id).toBe("draft-1");

      expect(grouped.columns.awaitingPayment).toHaveLength(1);
      expect(grouped.columns.awaitingPayment[0].id).toBe("awaiting-1");

      expect(grouped.columns.dueSoon).toHaveLength(1);
      expect(grouped.columns.dueSoon[0].id).toBe("due-soon-1");

      expect(grouped.columns.overdue).toHaveLength(1);
      expect(grouped.columns.overdue[0].id).toBe("overdue-1");

      expect(grouped.columns.paid).toHaveLength(1);
      expect(grouped.columns.paid[0].id).toBe("paid-1");

      // Outside the board tray
      expect(grouped.tray.needsReview).toHaveLength(1);
      expect(grouped.tray.needsReview[0].id).toBe("review-1");

      expect(grouped.tray.cancelled).toHaveLength(1);
      expect(grouped.tray.cancelled[0].id).toBe("cancelled-1");

      // Total counts
      expect(grouped.counts.all).toBe(7);
      expect(grouped.counts.needsReview).toBe(1);
      expect(grouped.counts.cancelled).toBe(1);
    });

    it("excludes cancelled and needs review invoices from primary Kanban board", () => {
      const invoices: InvoiceRecord[] = [
        createInvoice({ id: "rev", cashpilotStatus: CashPilotStatus.NEEDS_REVIEW }),
        createInvoice({ id: "can", cashpilotStatus: CashPilotStatus.CANCELLED }),
      ];

      const grouped = groupInvoicesForCollections(invoices, fixedNow);

      expect(grouped.columns.draft).toHaveLength(0);
      expect(grouped.columns.awaitingPayment).toHaveLength(0);
      expect(grouped.columns.dueSoon).toHaveLength(0);
      expect(grouped.columns.overdue).toHaveLength(0);
      expect(grouped.columns.paid).toHaveLength(0);

      expect(grouped.tray.needsReview).toHaveLength(1);
      expect(grouped.tray.cancelled).toHaveLength(1);
    });
  });

  describe("getInvoiceProvenance", () => {
    it("identifies PayPal verified invoices", () => {
      const inv = createInvoice({
        paypalInvoiceId: "INV2-ABC",
        paypalStatus: "SENT",
        isDemoData: false,
      });

      const prov = getInvoiceProvenance(inv);
      expect(prov.type).toBe("PAYPAL_VERIFIED");
      expect(prov.label).toBe("Verified by PayPal");
    });

    it("identifies sample data fixtures", () => {
      const inv = createInvoice({
        isDemoData: true,
        paypalInvoiceId: null,
      });

      const prov = getInvoiceProvenance(inv);
      expect(prov.type).toBe("SAMPLE_DATA");
      expect(prov.label).toBe("Sample data");
    });

    it("identifies AI drafted invoices", () => {
      const inv = createInvoice({
        aiDraftId: "ai-draft-123",
        paypalInvoiceId: null,
        isDemoData: false,
      });

      const prov = getInvoiceProvenance(inv);
      expect(prov.type).toBe("AI_DRAFTED");
      expect(prov.label).toBe("AI drafted · not in PayPal");
    });

    it("identifies stale sync warnings", () => {
      const inv = createInvoice({
        syncIsStale: true,
      });

      const prov = getInvoiceProvenance(inv);
      expect(prov.label).toContain("Sync Stale");
    });
  });
});
