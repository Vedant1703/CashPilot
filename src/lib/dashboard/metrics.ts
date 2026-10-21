/**
 * CashPilot AI — Dashboard & Collections Metrics
 *
 * SRS §5 & UI Design Reference: Authoritative calculation of dashboard metrics,
 * stage groupings, and provenance metadata.
 *
 * Financial integrity invariants:
 *   - Calculations use integer minor units (never JS floating-point arithmetic).
 *   - Totals count ONLY unpaid invoices that PayPal has confirmed as sent.
 *   - Drafts, cancelled, and unrecognised invoices are explicitly excluded from outstanding totals.
 *   - Paid state requires verified provider evidence; never counted paid merely because it was sent.
 *   - Date calculations are deterministic with injectable `now` for reproducible testing.
 */

import { CashPilotStatus } from "@prisma/client";
import { formatMoney } from "@/lib/money";

export interface InvoiceRecord {
  id: string;
  number: string | null;
  title: string | null;
  client: {
    id?: string;
    name: string;
    email: string;
    company?: string | null;
  };
  currency: string;
  totalMinorUnits: number;
  subtotalMinorUnits?: number;
  taxMinorUnits?: number;
  invoiceDate: Date | string;
  dueDate: Date | string;
  cashpilotStatus: CashPilotStatus;
  paypalStatus: string | null;
  paypalInvoiceId: string | null;
  isDemoData: boolean;
  syncIsStale: boolean;
  aiDraftId: string | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
  lastSyncAt?: Date | string | null;
  notes?: string | null;
  lineItems?: Array<{
    id?: string;
    description: string;
    quantity: number;
    unitPriceMinorUnits: number;
    totalMinorUnits: number;
  }>;
}

export interface MetricCardData {
  title: string;
  amountMinorUnits: number;
  formattedAmount: string;
  count: number;
  currency: string;
  contextText: string;
  href: string;
  badgeText?: string;
  badgeType?: "teal" | "orange" | "gold" | "red" | "muted";
}

export interface DashboardMetrics {
  outstanding: MetricCardData;
  overdue: MetricCardData;
  dueSoon: MetricCardData;
  paidThisMonth: MetricCardData;
  stageBreakdown: {
    stages: Array<{
      key: CashPilotStatus | "ALL";
      label: string;
      amountMinorUnits: number;
      formattedAmount: string;
      count: number;
      percentage: number;
      color: string;
    }>;
    totalOutstandingMinorUnits: number;
  };
  naviGreeting: {
    headline: string;
    body: string;
    actionRequiredCount: number;
    primaryActionLabel?: string;
    primaryActionHref?: string;
  };
}

export interface KanbanColumns {
  draft: InvoiceRecord[];
  awaitingPayment: InvoiceRecord[];
  dueSoon: InvoiceRecord[];
  overdue: InvoiceRecord[];
  paid: InvoiceRecord[];
}

export interface CollectionsTray {
  needsReview: InvoiceRecord[];
  cancelled: InvoiceRecord[];
}

export interface GroupedCollections {
  columns: KanbanColumns;
  tray: CollectionsTray;
  counts: {
    all: number;
    draft: number;
    awaitingPayment: number;
    dueSoon: number;
    overdue: number;
    paid: number;
    needsReview: number;
    cancelled: number;
  };
}

export interface InvoiceProvenance {
  type: "PAYPAL_VERIFIED" | "DEMO_PAYPAL_VERIFIED" | "AI_DRAFTED" | "SAMPLE_DATA" | "NEEDS_REVIEW" | "LOCAL_DRAFT";
  label: string;
  symbol: string;
  badgeClass: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Date Helper Utilities
// ─────────────────────────────────────────────────────────────────────────────

export function parseDate(dateOrString: Date | string): Date {
  return dateOrString instanceof Date ? dateOrString : new Date(dateOrString);
}

export function startOfDayUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

export function diffInDays(targetDate: Date, referenceDate: Date): number {
  const targetDay = startOfDayUtc(targetDate).getTime();
  const refDay = startOfDayUtc(referenceDate).getTime();
  return Math.round((targetDay - refDay) / (24 * 60 * 60 * 1000));
}

// ─────────────────────────────────────────────────────────────────────────────
// Provenance Classification
// ─────────────────────────────────────────────────────────────────────────────

export function getInvoiceProvenance(invoice: InvoiceRecord): InvoiceProvenance {
  if (invoice.syncIsStale) {
    return {
      type: "NEEDS_REVIEW",
      label: "Sync Stale · Last Known Status",
      symbol: "◷",
      badgeClass: "bg-[#FEF9E7] text-[#7A5600] border-[#F3E0A2]",
    };
  }

  if (invoice.cashpilotStatus === CashPilotStatus.NEEDS_REVIEW) {
    return {
      type: "NEEDS_REVIEW",
      label: "Needs Review · Unrecognised Status",
      symbol: "▲",
      badgeClass: "bg-[#FDF2EB] text-[#B4440B] border-[#F7C4A5]",
    };
  }

  if (invoice.paypalInvoiceId) {
    if (invoice.isDemoData) {
      return {
        type: "DEMO_PAYPAL_VERIFIED",
        label: "PayPal Sandbox Verified",
        symbol: "●",
        badgeClass: "bg-[#E8F5F1] text-[#0C7C61] border-[#A3D9CC]",
      };
    }
    return {
      type: "PAYPAL_VERIFIED",
      label: "Verified by PayPal",
      symbol: "●",
      badgeClass: "bg-[#E8F5F1] text-[#0C7C61] border-[#A3D9CC]",
    };
  }

  if (invoice.isDemoData) {
    return {
      type: "SAMPLE_DATA",
      label: "Sample data",
      symbol: "○",
      badgeClass: "bg-[#F4F6F8] text-[#5E718D] border-[#E3E8EF]",
    };
  }

  if (invoice.aiDraftId) {
    return {
      type: "AI_DRAFTED",
      label: "AI drafted · not in PayPal",
      symbol: "✦",
      badgeClass: "bg-[#F0EEFF] text-[#5B3FD0] border-[#CDC4FF]",
    };
  }

  return {
    type: "LOCAL_DRAFT",
    label: "Local draft",
    symbol: "○",
    badgeClass: "bg-[#F4F6F8] text-[#5E718D] border-[#E3E8EF]",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard Metrics Calculation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculates authoritative receivables metrics for the dashboard.
 *
 * @param invoices - Persisted invoice records for the workspace
 * @param now - Reference timestamp (injectable for testing)
 */
export function calculateDashboardMetrics(
  invoices: InvoiceRecord[],
  now: Date = new Date()
): DashboardMetrics {
  const currency = invoices[0]?.currency ?? "USD";

  // Filter 1: Sent, unpaid invoices (outstanding)
  // Per UI Design Reference: Totals count ONLY unpaid invoices that PayPal has confirmed as sent.
  // Drafts, cancelled, and unrecognised invoices are explicitly excluded.
  const sentUnpaidInvoices = invoices.filter((inv) => {
    if (inv.cashpilotStatus === CashPilotStatus.CANCELLED) return false;
    if (inv.cashpilotStatus === CashPilotStatus.DRAFT) return false;
    if (inv.cashpilotStatus === CashPilotStatus.NEEDS_REVIEW) return false;
    if (inv.cashpilotStatus === CashPilotStatus.PAID) return false;
    if (inv.paypalStatus === "PAID") return false;

    // Must be in sent lifecycle stage (AWAITING_PAYMENT, DUE_SOON, OVERDUE)
    return (
      inv.cashpilotStatus === CashPilotStatus.AWAITING_PAYMENT ||
      inv.cashpilotStatus === CashPilotStatus.DUE_SOON ||
      inv.cashpilotStatus === CashPilotStatus.OVERDUE ||
      inv.paypalStatus === "SENT"
    );
  });

  // Calculate Outstanding
  const outstandingAmount = sentUnpaidInvoices.reduce(
    (sum, inv) => sum + inv.totalMinorUnits,
    0
  );
  const outstandingCount = sentUnpaidInvoices.length;

  // Filter 2: Overdue invoices (past due date)
  const overdueInvoices = sentUnpaidInvoices.filter((inv) => {
    const days = diffInDays(parseDate(inv.dueDate), now);
    return days < 0 || inv.cashpilotStatus === CashPilotStatus.OVERDUE;
  });

  const overdueAmount = overdueInvoices.reduce(
    (sum, inv) => sum + inv.totalMinorUnits,
    0
  );
  const overdueCount = overdueInvoices.length;

  let oldestOverdueDays = 0;
  let oldestOverdueClient = "";
  if (overdueInvoices.length > 0) {
    for (const inv of overdueInvoices) {
      const daysLate = Math.abs(diffInDays(parseDate(inv.dueDate), now));
      if (daysLate >= oldestOverdueDays) {
        oldestOverdueDays = daysLate;
        oldestOverdueClient = inv.client.name;
      }
    }
  }

  // Filter 3: Due soon (0–3 days from now)
  const dueSoonInvoices = sentUnpaidInvoices.filter((inv) => {
    const days = diffInDays(parseDate(inv.dueDate), now);
    // Not overdue (days >= 0) and due within 3 days (days <= 3)
    const isWithin3Days = days >= 0 && days <= 3;
    const isDueSoonStatus =
      inv.cashpilotStatus === CashPilotStatus.DUE_SOON && days >= 0;
    return isWithin3Days || isDueSoonStatus;
  });

  const dueSoonAmount = dueSoonInvoices.reduce(
    (sum, inv) => sum + inv.totalMinorUnits,
    0
  );
  const dueSoonCount = dueSoonInvoices.length;

  let closestDueDays = 999;
  let closestDueClient = "";
  if (dueSoonInvoices.length > 0) {
    for (const inv of dueSoonInvoices) {
      const days = diffInDays(parseDate(inv.dueDate), now);
      if (days < closestDueDays) {
        closestDueDays = days;
        closestDueClient = inv.client.name;
      }
    }
  }

  // Filter 4: Paid this month
  const currentMonth = now.getUTCMonth();
  const currentYear = now.getUTCFullYear();

  const paidThisMonthInvoices = invoices.filter((inv) => {
    const isPaid =
      inv.cashpilotStatus === CashPilotStatus.PAID || inv.paypalStatus === "PAID";
    if (!isPaid) return false;

    // Determine relevant paid timestamp (lastSyncAt, updatedAt, or invoiceDate)
    const refDate = parseDate(inv.lastSyncAt ?? inv.updatedAt ?? inv.invoiceDate);
    return (
      refDate.getUTCMonth() === currentMonth &&
      refDate.getUTCFullYear() === currentYear
    );
  });

  const paidThisMonthAmount = paidThisMonthInvoices.reduce(
    (sum, inv) => sum + inv.totalMinorUnits,
    0
  );
  const paidThisMonthCount = paidThisMonthInvoices.length;

  // Outstanding by Stage Breakdown
  // Group sent unpaid into: Overdue, Due soon, Awaiting payment
  const awaitingInvoices = sentUnpaidInvoices.filter(
    (inv) => !overdueInvoices.includes(inv) && !dueSoonInvoices.includes(inv)
  );
  const awaitingAmount = awaitingInvoices.reduce(
    (sum, inv) => sum + inv.totalMinorUnits,
    0
  );

  const totalOutstanding = Math.max(outstandingAmount, 1); // Avoid division by 0

  const stages = [
    {
      key: CashPilotStatus.OVERDUE,
      label: "Overdue",
      amountMinorUnits: overdueAmount,
      formattedAmount: formatMoney(overdueAmount, currency),
      count: overdueCount,
      percentage: Math.round((overdueAmount / totalOutstanding) * 100),
      color: "#B42318",
    },
    {
      key: CashPilotStatus.DUE_SOON,
      label: "Due Soon (0–3d)",
      amountMinorUnits: dueSoonAmount,
      formattedAmount: formatMoney(dueSoonAmount, currency),
      count: dueSoonCount,
      percentage: Math.round((dueSoonAmount / totalOutstanding) * 100),
      color: "#7A5600",
    },
    {
      key: CashPilotStatus.AWAITING_PAYMENT,
      label: "Awaiting Payment",
      amountMinorUnits: awaitingAmount,
      formattedAmount: formatMoney(awaitingAmount, currency),
      count: awaitingInvoices.length,
      percentage: Math.round((awaitingAmount / totalOutstanding) * 100),
      color: "#0C7C61",
    },
  ];

  // Contextual Navi Greeting
  let naviHeadline = "Receivables are on track.";
  let naviBody = "No immediate follow-ups required today. All sent invoices are awaiting payment.";
  let actionRequiredCount = 0;
  let primaryActionLabel: string | undefined;
  let primaryActionHref: string | undefined;

  if (invoices.length === 0) {
    naviHeadline = "No invoices yet.";
    naviBody = "Start by creating your first invoice draft. Nothing is sent until you review and approve.";
    primaryActionLabel = "Describe an invoice";
    primaryActionHref = "/invoices/new";
  } else if (overdueCount > 0 && dueSoonCount > 0) {
    actionRequiredCount = overdueCount + dueSoonCount;
    naviHeadline = `${actionRequiredCount} invoices need your attention today.`;
    naviBody = `${oldestOverdueClient} is ${oldestOverdueDays} days overdue, and ${closestDueClient} is due in ${closestDueDays} days. I've prepared next steps. Nothing is sent until you approve.`;
    primaryActionLabel = "Review collections";
    primaryActionHref = "/collections?stage=overdue";
  } else if (overdueCount > 0) {
    actionRequiredCount = overdueCount;
    naviHeadline = `${overdueCount} invoice${overdueCount > 1 ? "s" : ""} overdue.`;
    naviBody = `${oldestOverdueClient} is ${oldestOverdueDays} days past due date. Consider sending a friendly reminder.`;
    primaryActionLabel = "Review overdue invoices";
    primaryActionHref = "/collections?stage=overdue";
  } else if (dueSoonCount > 0) {
    actionRequiredCount = dueSoonCount;
    naviHeadline = `${dueSoonCount} invoice${dueSoonCount > 1 ? "s" : ""} approaching deadline.`;
    naviBody = `${closestDueClient} is due in ${closestDueDays} day${closestDueDays === 1 ? "" : "s"}. Track incoming payments on the collections board.`;
    primaryActionLabel = "View due soon";
    primaryActionHref = "/collections?stage=due_soon";
  }

  return {
    outstanding: {
      title: "Outstanding",
      amountMinorUnits: outstandingAmount,
      formattedAmount: formatMoney(outstandingAmount, currency),
      count: outstandingCount,
      currency,
      contextText: `${outstandingCount} sent invoice${outstandingCount === 1 ? "" : "s"}`,
      href: "/collections?stage=awaiting",
      badgeText: "Unpaid sent",
      badgeType: "teal",
    },
    overdue: {
      title: "Overdue",
      amountMinorUnits: overdueAmount,
      formattedAmount: formatMoney(overdueAmount, currency),
      count: overdueCount,
      currency,
      contextText:
        overdueCount > 0
          ? `${overdueCount} invoice${overdueCount === 1 ? "" : "s"} · oldest ${oldestOverdueDays}d late`
          : "0 invoices overdue",
      href: "/collections?stage=overdue",
      badgeText: overdueCount > 0 ? `${oldestOverdueDays}d late` : undefined,
      badgeType: "red",
    },
    dueSoon: {
      title: "Due Soon (0–3 Days)",
      amountMinorUnits: dueSoonAmount,
      formattedAmount: formatMoney(dueSoonAmount, currency),
      count: dueSoonCount,
      currency,
      contextText:
        dueSoonCount > 0
          ? `${dueSoonCount} invoice${dueSoonCount === 1 ? "" : "s"} due within 3 days`
          : "No invoices due soon",
      href: "/collections?stage=due_soon",
      badgeText: dueSoonCount > 0 ? "Upcoming" : undefined,
      badgeType: "gold",
    },
    paidThisMonth: {
      title: "Paid This Month",
      amountMinorUnits: paidThisMonthAmount,
      formattedAmount: formatMoney(paidThisMonthAmount, currency),
      count: paidThisMonthCount,
      currency,
      contextText:
        paidThisMonthCount > 0
          ? `${paidThisMonthCount} invoice${paidThisMonthCount === 1 ? "" : "s"} · confirmed by PayPal`
          : "0 payments recorded this month",
      href: "/collections?stage=paid",
      badgeText: paidThisMonthCount > 0 ? "Confirmed" : undefined,
      badgeType: "teal",
    },
    stageBreakdown: {
      stages,
      totalOutstandingMinorUnits: outstandingAmount,
    },
    naviGreeting: {
      headline: naviHeadline,
      body: naviBody,
      actionRequiredCount,
      primaryActionLabel,
      primaryActionHref,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Collections Grouping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Groups invoices into Collections Kanban columns and outside-the-board trays.
 *
 * Primary Board:
 *   1. Draft (local or PayPal draft, not sent)
 *   2. Awaiting Payment (sent, not yet due or approaching due date)
 *   3. Due Soon (0–3 days before due date)
 *   4. Overdue (due date passed without payment confirmation)
 *   5. Paid (PayPal confirmed paid)
 *
 * Outside the Board Tray:
 *   - Needs Review (unrecognised provider status or sync anomaly)
 *   - Cancelled (cancelled invoices)
 */
export function groupInvoicesForCollections(
  invoices: InvoiceRecord[],
  now: Date = new Date()
): GroupedCollections {
  const columns: KanbanColumns = {
    draft: [],
    awaitingPayment: [],
    dueSoon: [],
    overdue: [],
    paid: [],
  };

  const tray: CollectionsTray = {
    needsReview: [],
    cancelled: [],
  };

  for (const inv of invoices) {
    // Check terminal and exceptional states first
    if (inv.cashpilotStatus === CashPilotStatus.CANCELLED) {
      tray.cancelled.push(inv);
      continue;
    }

    if (inv.cashpilotStatus === CashPilotStatus.NEEDS_REVIEW) {
      tray.needsReview.push(inv);
      continue;
    }

    if (inv.cashpilotStatus === CashPilotStatus.PAID || inv.paypalStatus === "PAID") {
      columns.paid.push(inv);
      continue;
    }

    if (inv.cashpilotStatus === CashPilotStatus.DRAFT) {
      columns.draft.push(inv);
      continue;
    }

    // Invoice is sent and unpaid: determine column based on due date
    const daysUntilDue = diffInDays(parseDate(inv.dueDate), now);

    if (daysUntilDue < 0 || inv.cashpilotStatus === CashPilotStatus.OVERDUE) {
      columns.overdue.push(inv);
    } else if (
      (daysUntilDue >= 0 && daysUntilDue <= 3) ||
      inv.cashpilotStatus === CashPilotStatus.DUE_SOON
    ) {
      columns.dueSoon.push(inv);
    } else {
      columns.awaitingPayment.push(inv);
    }
  }

  // Sort each column by due date
  columns.overdue.sort(
    (a, b) => parseDate(a.dueDate).getTime() - parseDate(b.dueDate).getTime()
  );
  columns.dueSoon.sort(
    (a, b) => parseDate(a.dueDate).getTime() - parseDate(b.dueDate).getTime()
  );
  columns.awaitingPayment.sort(
    (a, b) => parseDate(a.dueDate).getTime() - parseDate(b.dueDate).getTime()
  );
  columns.draft.sort(
    (a, b) => parseDate(b.invoiceDate).getTime() - parseDate(a.invoiceDate).getTime()
  );
  columns.paid.sort(
    (a, b) =>
      parseDate(b.lastSyncAt ?? b.updatedAt ?? b.invoiceDate).getTime() -
      parseDate(a.lastSyncAt ?? a.updatedAt ?? a.invoiceDate).getTime()
  );

  return {
    columns,
    tray,
    counts: {
      all: invoices.length,
      draft: columns.draft.length,
      awaitingPayment: columns.awaitingPayment.length,
      dueSoon: columns.dueSoon.length,
      overdue: columns.overdue.length,
      paid: columns.paid.length,
      needsReview: tray.needsReview.length,
      cancelled: tray.cancelled.length,
    },
  };
}
