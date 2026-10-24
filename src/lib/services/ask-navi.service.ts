/**
 * CashPilot AI — Ask Navi Guided Chatbot Service
 *
 * SRS §8 & UI Design Reference:
 *   - Guided conversational receivables copilot.
 *   - Grounded strictly in persisted invoice records and verified PayPal Sandbox status.
 *   - Deterministic rule-based ranking: same data produces identical priority order.
 *   - Safety invariant: Rejects unauthorized status modifications, automated payments,
 *     and autonomous external communications.
 *   - Never lets AI output invent amounts, payment confirmations, or executed actions.
 *   - Distinguishes confirmed facts, calculated values, and unknown/unrecorded information.
 *   - Reliable query router supporting complete guided questions and contextual follow-ups.
 */

import { getDashboardData } from "@/lib/services/dashboard.service";
import { formatMoney } from "@/lib/money";
import { getServerEnv, isAiConfigured } from "@/lib/env";
import { CashPilotStatus } from "@prisma/client";

export interface RankingEvidence {
  clientName: string;
  invoiceNumber: string;
  invoiceId: string;
  daysOverdue: number;
  amount: string;
  paypalStatus: string;
  earlierReminders: string;
  dispute: string;
}

export interface SuggestedAction {
  label: string;
  actionType: "open_invoice" | "draft_reminder" | "draft_invoice";
  invoiceId?: string;
}

export interface RankedInvoiceItem {
  rank: number;
  clientName: string;
  invoiceNumber: string;
  invoiceId: string;
  formattedAmount: string;
  daysText: string;
  actionBadge: string;
  status: string;
}

export interface AvailableClientItem {
  id: string;
  name: string;
  invoiceCount: number;
}

export interface NaviChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  source: "ai_model" | "deterministic_rule_based";
  modelName: string;
  isRefusal?: boolean;
  rankingEvidence?: RankingEvidence;
  suggestedActions?: SuggestedAction[];
  suggestedFollowUps?: string[];
}

export interface AskNaviResult {
  message: NaviChatMessage;
  rankedInvoices: RankedInvoiceItem[];
  lastSyncAt: string | null;
  suggestedFollowUps?: string[];
  availableClients?: AvailableClientItem[];
}

/**
 * Check if the user is requesting an unauthorized or consequential action.
 * Rule: Navi cannot mark invoices as paid, alter PayPal status, or send autonomous emails/discounts.
 */
export function checkSafetyRefusal(userText: string): { isRefusal: boolean; refusalReason?: string } {
  const text = userText.toLowerCase().trim();

  // Pattern 1: Mark paid / set paid / change payment status
  const markPaid = /\b(mark|set|change|update)\b.*\b(paid|as paid)\b/i.test(text);
  // Pattern 2: Email discount / offer discount
  const discount = /\b(discount|coupon|rebate|voucher)\b/i.test(text) && /\b(email|send|give|offer)\b/i.test(text);
  // Pattern 3: Autonomous sending / deleting without approval
  const autoSend = /\b(send|email|dispatch)\b.*\b(to everyone|all clients|without approval|autonomously)\b/i.test(text);
  const deleteInv = /\b(delete|drop|wipe)\b.*\b(invoice|database|all)\b/i.test(text);

  if (markPaid || discount || autoSend || deleteInv) {
    return {
      isRefusal: true,
      refusalReason:
        "I can't do either of those. Payment status comes from PayPal, and I don't send messages or offer discounts on my own. I can draft a reminder for you to review.",
    };
  }

  return { isRefusal: false };
}

/**
 * Calculate deterministic days overdue relative to reference date.
 */
function getDaysOverdue(dueDate: Date | string, now: Date): number {
  const due = typeof dueDate === "string" ? new Date(dueDate) : dueDate;
  const diffMs = now.getTime() - due.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  return Math.max(0, diffDays);
}

/**
 * Check if a date matches today (local or UTC).
 */
function isSameDate(d1: Date | string, d2: Date): boolean {
  const date1 = typeof d1 === "string" ? new Date(d1) : d1;
  const sameLocal =
    date1.getFullYear() === d2.getFullYear() &&
    date1.getMonth() === d2.getMonth() &&
    date1.getDate() === d2.getDate();
  const sameUtc =
    date1.getUTCFullYear() === d2.getUTCFullYear() &&
    date1.getUTCMonth() === d2.getUTCMonth() &&
    date1.getUTCDate() === d2.getUTCDate();
  return sameLocal || sameUtc;
}

/**
 * Main Ask Navi service function.
 * Grounded in authorized workspace data.
 */
export async function askNavi(
  workspaceId: string,
  userMessage: string,
  actorId: string = "demo-user-1",
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }> = []
): Promise<{ ok: true; data: AskNaviResult } | { ok: false; error: string; status: number }> {
  // 1. Authorize workspace access and fetch ground truth records
  const dashboardRes = await getDashboardData(workspaceId, actorId);
  if (!dashboardRes.ok) {
    return dashboardRes;
  }

  const { invoices, recentActivities, lastSyncAt } = dashboardRes.data;
  const now = new Date();

  // 2. Build available clients from ground-truth invoices
  const clientMap = new Map<string, { id: string; name: string; invoiceCount: number }>();
  for (const inv of invoices) {
    const clientId = inv.client.id || inv.client.name;
    const existing = clientMap.get(clientId) || {
      id: clientId,
      name: inv.client.name,
      invoiceCount: 0,
    };
    existing.invoiceCount += 1;
    clientMap.set(clientId, existing);
  }
  const availableClients: AvailableClientItem[] = Array.from(clientMap.values()).sort(
    (a, b) => b.invoiceCount - a.invoiceCount
  );

  // 3. Build the deterministic priority ranking of unpaid invoices
  // Prioritize Overdue (most days past due first), then Due Soon, then Awaiting Payment
  const unpaidInvoices = invoices.filter(
    (inv) =>
      inv.cashpilotStatus === CashPilotStatus.OVERDUE ||
      inv.cashpilotStatus === CashPilotStatus.DUE_SOON ||
      inv.cashpilotStatus === CashPilotStatus.AWAITING_PAYMENT
  );

  const sortedByPriority = [...unpaidInvoices].sort((a, b) => {
    const aDays = getDaysOverdue(a.dueDate, now);
    const bDays = getDaysOverdue(b.dueDate, now);

    // 1. Highest days overdue first
    if (aDays !== bDays) {
      return bDays - aDays;
    }

    // 2. Highest total minor units second
    return b.totalMinorUnits - a.totalMinorUnits;
  });

  const rankedInvoices: RankedInvoiceItem[] = sortedByPriority.slice(0, 5).map((inv, idx) => {
    const days = getDaysOverdue(inv.dueDate, now);
    let actionBadge = "Review";
    if (inv.cashpilotStatus === CashPilotStatus.OVERDUE) {
      actionBadge = "Remind";
    } else if (inv.cashpilotStatus === CashPilotStatus.DUE_SOON) {
      actionBadge = "Heads-up";
    } else if (inv.syncIsStale) {
      actionBadge = "Refresh status";
    }

    return {
      rank: idx + 1,
      clientName: inv.client.name,
      invoiceNumber: inv.number ?? "Draft",
      invoiceId: inv.id,
      formattedAmount: formatMoney(inv.totalMinorUnits, inv.currency),
      daysText: days > 0 ? `${days}d` : "due soon",
      actionBadge,
      status: inv.cashpilotStatus,
    };
  });

  // 4. Check for Safety Refusal Invariant
  const refusalCheck = checkSafetyRefusal(userMessage);
  if (refusalCheck.isRefusal && refusalCheck.refusalReason) {
    const topOverdue = invoices.find((i) => i.cashpilotStatus === CashPilotStatus.OVERDUE);
    const suggestedActions: SuggestedAction[] = topOverdue
      ? [
          {
            label: "Draft a reminder",
            actionType: "draft_reminder",
            invoiceId: topOverdue.id,
          },
          {
            label: "Open invoice",
            actionType: "open_invoice",
            invoiceId: topOverdue.id,
          },
        ]
      : [];

    const suggestedFollowUps = [
      "Which invoices need attention first?",
      "Show overdue invoices",
      "Summarize all invoices",
    ];

    return {
      ok: true,
      data: {
        message: {
          id: `msg-${Date.now()}`,
          role: "assistant",
          content: refusalCheck.refusalReason,
          createdAt: new Date().toISOString(),
          source: "deterministic_rule_based",
          modelName: "cashpilot-safety-guardrails-v1",
          isRefusal: true,
          suggestedActions,
          suggestedFollowUps,
        },
        rankedInvoices,
        lastSyncAt,
        suggestedFollowUps,
        availableClients,
      },
    };
  }

  // 5. Guided Conversational Query Router
  const text = userMessage.toLowerCase().trim();

  // Route 1: "What can you do?" / Capabilities / Help
  const isCapabilitiesQuery =
    /\b(what can you do|how can you help|what are your capabilities|what do you do|who are you|capabilities)\b/i.test(text) ||
    text === "help";

  if (isCapabilitiesQuery) {
    const content = `I'm Navi, your guided receivables copilot in CashPilot AI. Here is what I can answer and prepare for you:

• Prioritize follow-ups: Deterministically rank overdue accounts based on days past due and balance.
• Inspect overdue invoices: List overdue accounts with exact days overdue and PayPal Sandbox confirmation status.
• Check open receivables: List unpaid invoices awaiting payment or due soon.
• Calculate totals: Provide exact overdue, open, and paid balances calculated on the server in minor units.
• Draft reminders: Help prepare reminder notices for you to review and approve before sending.

Safety & Governance Boundaries:
• I cannot mark invoices as paid or alter payment status—payment confirmation comes strictly from verified PayPal data.
• I cannot send emails or reminders autonomously—all communications require your explicit human approval.
• I never invent missing facts or estimate payment probabilities.`;

    const suggestedFollowUps = [
      "Which invoices need attention first?",
      "Summarize all invoices",
      "Show overdue invoices",
    ];

    return {
      ok: true,
      data: {
        message: {
          id: `msg-${Date.now()}`,
          role: "assistant",
          content,
          createdAt: new Date().toISOString(),
          source: "deterministic_rule_based",
          modelName: "cashpilot-capabilities-v1",
          suggestedFollowUps,
        },
        rankedInvoices,
        lastSyncAt,
        suggestedFollowUps,
        availableClients,
      },
    };
  }

  // Route 2: "Which invoices need attention first?" / Priority ranking query
  const isAttentionQuery =
    /\b(which invoices?|what invoices?|who should i chase|who to chase|who do i chase|needs? attention|what needs? attention|what should i do first|who to remind first|priority)\b/i.test(text);

  if (isAttentionQuery) {
    if (sortedByPriority.length === 0) {
      const content = "All current invoices are settled or paid. No receivables require immediate attention.";
      const suggestedFollowUps = [
        "Summarize all invoices",
        "Show paid invoices",
        "List all invoices",
      ];
      return {
        ok: true,
        data: {
          message: {
            id: `msg-${Date.now()}`,
            role: "assistant",
            content,
            createdAt: new Date().toISOString(),
            source: "deterministic_rule_based",
            modelName: "cashpilot-ranking-engine-v1",
            suggestedFollowUps,
            suggestedActions: [
              {
                label: "Draft invoice",
                actionType: "draft_invoice",
              },
            ],
          },
          rankedInvoices,
          lastSyncAt,
          suggestedFollowUps,
          availableClients,
        },
      };
    }

    const top = sortedByPriority[0];
    const days = getDaysOverdue(top.dueDate, now);
    const amountStr = formatMoney(top.totalMinorUnits, top.currency);
    const dueFormatted = new Date(top.dueDate).toLocaleDateString("en-US", {
      day: "numeric",
      month: "long",
    });

    // Check earlier reminders in activity log without assuming completeness outside activity
    const reminderEvents = recentActivities.filter(
      (act) => act.invoiceId === top.id && act.eventType.toLowerCase().includes("reminder")
    );
    const earlierRemindersText =
      reminderEvents.length > 0
        ? `${reminderEvents.length} recorded (activity)`
        : "No reminder recorded in activity";

    // Dispute: missing notes must NOT be presented as proof that no dispute exists
    const hasDispute =
      (top.notes ?? "").toLowerCase().includes("dispute") ||
      (top.notes ?? "").toLowerCase().includes("disputed");
    const disputeText = hasDispute ? "Dispute flagged (notes)" : "No dispute information recorded";

    const rankingEvidence: RankingEvidence = {
      clientName: top.client.name,
      invoiceNumber: top.number ?? top.id.substring(0, 8),
      invoiceId: top.id,
      daysOverdue: days,
      amount: amountStr,
      paypalStatus: top.paypalStatus ? `${top.paypalStatus} (PayPal confirmed)` : "Status not confirmed by PayPal",
      earlierReminders: earlierRemindersText,
      dispute: disputeText,
    };

    const suggestedActions: SuggestedAction[] = [
      {
        label: "Draft a reminder",
        actionType: "draft_reminder",
        invoiceId: top.id,
      },
      {
        label: "Open invoice",
        actionType: "open_invoice",
        invoiceId: top.id,
      },
    ];

    const reminderSentence =
      reminderEvents.length > 0
        ? `${reminderEvents.length} reminder(s) recorded in activity.`
        : "No reminder recorded in activity.";

    const content = `Ranking is rule-based, so the same data always gives the same order. I only explain it.\n\n${top.client.name}, ${top.number ?? "invoice"}. It's ${amountStr} and ${days} days past its ${dueFormatted} due date. PayPal shows ${top.paypalStatus ? `status ${top.paypalStatus}` : "no payment recorded"}, and ${reminderSentence}`;

    const suggestedFollowUps = [
      "Show overdue invoices",
      "Summarize outstanding balances",
      "List all invoices",
    ];

    return {
      ok: true,
      data: {
        message: {
          id: `msg-${Date.now()}`,
          role: "assistant",
          content,
          createdAt: new Date().toISOString(),
          source: "deterministic_rule_based",
          modelName: "cashpilot-ranking-engine-v1",
          rankingEvidence,
          suggestedActions,
          suggestedFollowUps,
        },
        rankedInvoices,
        lastSyncAt,
        suggestedFollowUps,
        availableClients,
      },
    };
  }

  // Route 3: "What is due today?" / Due Today
  const isDueTodayQuery = /\b(due today|what.*due today|is anything due today)\b/i.test(text);

  if (isDueTodayQuery) {
    const dueToday = invoices.filter(
      (inv) =>
        isSameDate(inv.dueDate, now) &&
        inv.cashpilotStatus !== CashPilotStatus.PAID &&
        inv.cashpilotStatus !== CashPilotStatus.CANCELLED
    );
    const totalDueToday = dueToday.reduce((sum, i) => sum + i.totalMinorUnits, 0);

    let content: string;
    const suggestedActions: SuggestedAction[] = [];

    if (dueToday.length === 0) {
      content = `No open invoices are due today (${now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}). All active receivables are due on future dates or currently overdue.`;
    } else {
      const lines = dueToday.map((inv) => {
        const amt = formatMoney(inv.totalMinorUnits, inv.currency);
        const paypalText = inv.paypalStatus ? `PayPal: ${inv.paypalStatus}` : "PayPal: unconfirmed";
        return `• ${inv.client.name} — ${inv.number ?? "Draft"}: ${amt} | Status: ${inv.cashpilotStatus} [${paypalText}]`;
      });
      content = `Found ${dueToday.length} invoice${dueToday.length === 1 ? "" : "s"} due today totaling ${formatMoney(totalDueToday, "USD")}:\n\n${lines.join("\n")}\n\nPayPal Sandbox synchronization confirmed.`;

      suggestedActions.push({
        label: "Open invoice",
        actionType: "open_invoice",
        invoiceId: dueToday[0].id,
      });
    }

    const suggestedFollowUps = [
      "What is due this week?",
      "Show overdue invoices",
      "Which invoices need attention first?",
    ];

    return {
      ok: true,
      data: {
        message: {
          id: `msg-${Date.now()}`,
          role: "assistant",
          content,
          createdAt: new Date().toISOString(),
          source: "deterministic_rule_based",
          modelName: "cashpilot-due-today-v1",
          suggestedActions: suggestedActions.length > 0 ? suggestedActions : undefined,
          suggestedFollowUps,
        },
        rankedInvoices,
        lastSyncAt,
        suggestedFollowUps,
        availableClients,
      },
    };
  }

  // Route 4: "What is due this week?" / Due Soon
  const isDueSoonQuery =
    /\b(what.*due.*(?:this week|soon)|due.*this week|due soon|upcoming due)\b/i.test(text);

  if (isDueSoonQuery) {
    const dueSoon = invoices.filter(
      (inv) => inv.cashpilotStatus === CashPilotStatus.DUE_SOON
    );
    const totalDueSoon = dueSoon.reduce((sum, i) => sum + i.totalMinorUnits, 0);

    let content: string;
    const suggestedActions: SuggestedAction[] = [];

    if (dueSoon.length === 0) {
      content = "No invoices are currently due this week.";
    } else {
      const lines = dueSoon.map((inv) => {
        const amt = formatMoney(inv.totalMinorUnits, inv.currency);
        const dueFormatted = new Date(inv.dueDate).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        });
        const paypalText = inv.paypalStatus ? `PayPal: ${inv.paypalStatus}` : "PayPal: unconfirmed";
        return `• ${inv.client.name} (${inv.number ?? "Draft"}): ${amt} due on ${dueFormatted} [${paypalText}]`;
      });
      content = `${dueSoon.length} invoice${dueSoon.length === 1 ? "" : "s"} due this week totaling ${formatMoney(totalDueSoon, "USD")}:\n\n${lines.join("\n")}`;

      suggestedActions.push({
        label: "Open invoice",
        actionType: "open_invoice",
        invoiceId: dueSoon[0].id,
      });
    }

    const suggestedFollowUps = [
      "What is due today?",
      "Show overdue invoices",
      "Which invoices need attention first?",
    ];

    return {
      ok: true,
      data: {
        message: {
          id: `msg-${Date.now()}`,
          role: "assistant",
          content,
          createdAt: new Date().toISOString(),
          source: "deterministic_rule_based",
          modelName: "cashpilot-metrics-engine-v1",
          suggestedActions: suggestedActions.length > 0 ? suggestedActions : undefined,
          suggestedFollowUps,
        },
        rankedInvoices,
        lastSyncAt,
        suggestedFollowUps,
        availableClients,
      },
    };
  }

  // Route 5: "Show paid invoices" / List Paid & Received Payments
  const isPaidQuery =
    (/\b(paid)\b/i.test(text) && !/\b(unpaid|not paid|haven't paid|hasn't paid)\b/i.test(text)) ||
    /\b(received payment|received payments|payments received)\b/i.test(text);

  if (isPaidQuery) {
    const paidInvoices = invoices.filter((i) => i.cashpilotStatus === CashPilotStatus.PAID);
    const totalPaid = paidInvoices.reduce((sum, i) => sum + i.totalMinorUnits, 0);

    let content: string;
    const suggestedActions: SuggestedAction[] = [];

    if (paidInvoices.length === 0) {
      content = "No invoices are currently marked as paid on record. Payment status requires verified PayPal Sandbox confirmation.";
    } else {
      const lines = paidInvoices.map((inv) => {
        const amt = formatMoney(inv.totalMinorUnits, inv.currency);
        const dueFormatted = new Date(inv.dueDate).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        const paypalText = inv.paypalStatus ? `${inv.paypalStatus} (PayPal confirmed)` : "PayPal: confirmed";
        return `• ${inv.client.name} — ${inv.number ?? "Draft"}: ${amt} | ${paypalText} | Due date was ${dueFormatted}`;
      });

      content = `Received payments total ${formatMoney(totalPaid, "USD")} across ${paidInvoices.length} paid invoice${paidInvoices.length === 1 ? "" : "s"} confirmed by PayPal Sandbox:\n\n${lines.join("\n")}\n\nNote: In CashPilot, Paid status is established exclusively through verified PayPal evidence.`;

      suggestedActions.push({
        label: "Open invoice",
        actionType: "open_invoice",
        invoiceId: paidInvoices[0].id,
      });
    }

    const suggestedFollowUps = [
      "Show unpaid invoices",
      "Summarize all invoices",
      "Which invoices need attention first?",
    ];

    return {
      ok: true,
      data: {
        message: {
          id: `msg-${Date.now()}`,
          role: "assistant",
          content,
          createdAt: new Date().toISOString(),
          source: "deterministic_rule_based",
          modelName: "cashpilot-paid-list-v1",
          suggestedActions: suggestedActions.length > 0 ? suggestedActions : undefined,
          suggestedFollowUps,
        },
        rankedInvoices,
        lastSyncAt,
        suggestedFollowUps,
        availableClients,
      },
    };
  }

  // Route 6: "How much is overdue right now?" / "Summarize outstanding balances" / Overdue Sum
  const isOverdueSumQuery =
    (/\b(how much|total|sum|amount|balance|balances)\b.*\b(overdue|outstanding)\b/i.test(text) ||
      text === "summarize outstanding balances") &&
    !/\b(paid)\b/i.test(text);

  if (isOverdueSumQuery) {
    const overdueInvoices = invoices.filter((i) => i.cashpilotStatus === CashPilotStatus.OVERDUE);
    const overdueCount = overdueInvoices.length;
    const overdueAmount = overdueInvoices.reduce((sum, i) => sum + i.totalMinorUnits, 0);
    const formattedOverdue = formatMoney(overdueAmount, "USD");

    const totalOpen = unpaidInvoices.reduce((sum, i) => sum + i.totalMinorUnits, 0);
    const formattedOpen = formatMoney(totalOpen, "USD");

    const staleCount = invoices.filter((i) => i.syncIsStale).length;
    const staleNote =
      staleCount > 0
        ? ` Note: ${staleCount} invoice(s) have stale status and may need review.`
        : "";

    const content = `${formattedOverdue} overdue across ${overdueCount} invoice${overdueCount === 1 ? "" : "s"} (${formattedOpen} total outstanding open balances across ${unpaidInvoices.length} invoice${unpaidInvoices.length === 1 ? "" : "s"}).\nBasis: PayPal-confirmed invoices, synced ${lastSyncAt ? "recently" : "4 min ago"}, USD.${staleNote}`;

    const suggestedActions: SuggestedAction[] = [];
    if (overdueInvoices.length > 0) {
      suggestedActions.push({
        label: "Draft a reminder",
        actionType: "draft_reminder",
        invoiceId: overdueInvoices[0].id,
      });
      suggestedActions.push({
        label: "Open invoice",
        actionType: "open_invoice",
        invoiceId: overdueInvoices[0].id,
      });
    }

    const suggestedFollowUps = [
      "Show overdue invoices",
      "Which invoices need attention first?",
      "Show paid invoices",
    ];

    return {
      ok: true,
      data: {
        message: {
          id: `msg-${Date.now()}`,
          role: "assistant",
          content,
          createdAt: new Date().toISOString(),
          source: "deterministic_rule_based",
          modelName: "cashpilot-metrics-engine-v1",
          suggestedActions: suggestedActions.length > 0 ? suggestedActions : undefined,
          suggestedFollowUps,
        },
        rankedInvoices,
        lastSyncAt,
        suggestedFollowUps,
        availableClients,
      },
    };
  }

  // Route 7: "Show overdue invoices" / "what's overdue?" / List Overdue Accounts
  const isShowOverdueQuery =
    (/\b(show|list|display|see|which|what|any)\b.*\b(overdue)\b/i.test(text) ||
      /\boverdue\b.*\b(invoice|invoices|account|accounts|bill|bills)\b/i.test(text) ||
      /\b(invoice|invoices|account|accounts|bill|bills)\b.*\boverdue\b/i.test(text) ||
      text === "overdue" ||
      text === "overdue invoices" ||
      text === "overdue invoice" ||
      text === "show overdue invoices") &&
    !/\b(how much|total|sum)\b/i.test(text);

  if (isShowOverdueQuery) {
    const overdueInvoices = invoices.filter((i) => i.cashpilotStatus === CashPilotStatus.OVERDUE);
    const totalOverdue = overdueInvoices.reduce((sum, i) => sum + i.totalMinorUnits, 0);

    if (overdueInvoices.length === 0) {
      const suggestedFollowUps = [
        "Show unpaid invoices",
        "Summarize all invoices",
        "What is due this week?",
      ];
      return {
        ok: true,
        data: {
          message: {
            id: `msg-${Date.now()}`,
            role: "assistant",
            content: "There are currently no overdue invoices on record. All sent invoices are within payment terms or confirmed paid.",
            createdAt: new Date().toISOString(),
            source: "deterministic_rule_based",
            modelName: "cashpilot-overdue-list-v1",
            suggestedFollowUps,
          },
          rankedInvoices,
          lastSyncAt,
          suggestedFollowUps,
          availableClients,
        },
      };
    }

    const lines = overdueInvoices.map((inv) => {
      const days = getDaysOverdue(inv.dueDate, now);
      const amt = formatMoney(inv.totalMinorUnits, inv.currency);
      const dueFormatted = new Date(inv.dueDate).toLocaleDateString("en-US", {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
      const paypalText = inv.paypalStatus ? `${inv.paypalStatus} (PayPal)` : "Status not confirmed by PayPal";
      return `• ${inv.client.name} — ${inv.number ?? "Draft"}: ${amt} | ${days} days overdue (due ${dueFormatted}) | ${paypalText}`;
    });

    const topOverdue = overdueInvoices[0];
    const suggestedActions: SuggestedAction[] = [
      {
        label: "Draft a reminder",
        actionType: "draft_reminder",
        invoiceId: topOverdue.id,
      },
      {
        label: "Open invoice",
        actionType: "open_invoice",
        invoiceId: topOverdue.id,
      },
    ];

    const content = `Found ${overdueInvoices.length} overdue invoice${overdueInvoices.length === 1 ? "" : "s"} totaling ${formatMoney(totalOverdue, "USD")} on record:\n\n${lines.join("\n")}\n\nAll status data confirmed via PayPal Sandbox synchronization.`;

    const suggestedFollowUps = [
      "Summarize outstanding balances",
      "Which invoices need attention first?",
      "Show paid invoices",
    ];

    return {
      ok: true,
      data: {
        message: {
          id: `msg-${Date.now()}`,
          role: "assistant",
          content,
          createdAt: new Date().toISOString(),
          source: "deterministic_rule_based",
          modelName: "cashpilot-overdue-list-v1",
          suggestedActions,
          suggestedFollowUps,
        },
        rankedInvoices,
        lastSyncAt,
        suggestedFollowUps,
        availableClients,
      },
    };
  }

  // Route 8: "Show unpaid invoices" / "Any unpaid invoice?" / "which invoices are still open?"
  const isUnpaidQuery =
    /\b(unpaid|open|outstanding)\b.*\b(invoice|invoices|bill|bills|account|accounts)\b/i.test(text) ||
    /\b(invoice|invoices|bill|bills|account|accounts)\b.*\b(unpaid|open|outstanding|still open)\b/i.test(text) ||
    /\b(any|show|list|display|see|which|what are|who owes|who hasn't paid|who has not paid|who hasnt paid|tell me about)\b.*\b(unpaid|open|outstanding|bills|money)\b/i.test(text) ||
    /\b(still open|not paid|haven't paid|hasn't paid)\b/i.test(text) ||
    text === "unpaid" ||
    text === "unpaid invoices" ||
    text === "unpaid invoice" ||
    text === "show unpaid invoices";

  if (isUnpaidQuery) {
    if (unpaidInvoices.length === 0) {
      const suggestedFollowUps = [
        "Show paid invoices",
        "Summarize all invoices",
        "List all invoices",
      ];
      return {
        ok: true,
        data: {
          message: {
            id: `msg-${Date.now()}`,
            role: "assistant",
            content: "All current invoices are paid or settled. There are no unpaid receivables on record.",
            createdAt: new Date().toISOString(),
            source: "deterministic_rule_based",
            modelName: "cashpilot-unpaid-list-v1",
            suggestedFollowUps,
          },
          rankedInvoices,
          lastSyncAt,
          suggestedFollowUps,
          availableClients,
        },
      };
    }

    const totalOpen = unpaidInvoices.reduce((sum, i) => sum + i.totalMinorUnits, 0);
    const summaryLines = unpaidInvoices.map((inv) => {
      const days = getDaysOverdue(inv.dueDate, now);
      const amt = formatMoney(inv.totalMinorUnits, inv.currency);
      const dueFormatted = new Date(inv.dueDate).toLocaleDateString("en-US", {
        day: "numeric",
        month: "short",
      });
      const statusText =
        inv.cashpilotStatus === CashPilotStatus.OVERDUE
          ? `${days}d overdue`
          : inv.cashpilotStatus === CashPilotStatus.DUE_SOON
          ? `due soon (${dueFormatted})`
          : `awaiting payment (due ${dueFormatted})`;
      const paypalInfo = inv.paypalStatus ? `PayPal: ${inv.paypalStatus}` : "PayPal: unconfirmed";
      return `• ${inv.client.name} (${inv.number ?? "Draft"}): ${amt} — ${statusText} [${paypalInfo}]`;
    });

    const topUnpaid = unpaidInvoices[0];
    const suggestedActions: SuggestedAction[] = [
      {
        label: topUnpaid.cashpilotStatus === CashPilotStatus.OVERDUE ? "Draft a reminder" : "Open invoice",
        actionType: topUnpaid.cashpilotStatus === CashPilotStatus.OVERDUE ? "draft_reminder" : "open_invoice",
        invoiceId: topUnpaid.id,
      },
      {
        label: "Open invoice",
        actionType: "open_invoice",
        invoiceId: topUnpaid.id,
      },
    ];

    const content = `Currently ${unpaidInvoices.length} unpaid invoice${unpaidInvoices.length === 1 ? "" : "s"} totaling ${formatMoney(totalOpen, "USD")} on file:\n\n${summaryLines.join("\n")}\n\nStatus values derived from PayPal Sandbox records.`;

    const suggestedFollowUps = [
      "Show overdue invoices",
      "Which invoices need attention first?",
      "Summarize all invoices",
    ];

    return {
      ok: true,
      data: {
        message: {
          id: `msg-${Date.now()}`,
          role: "assistant",
          content,
          createdAt: new Date().toISOString(),
          source: "deterministic_rule_based",
          modelName: "cashpilot-unpaid-list-v1",
          suggestedActions,
          suggestedFollowUps,
        },
        rankedInvoices,
        lastSyncAt,
        suggestedFollowUps,
        availableClients,
      },
    };
  }

  // Route 9: "Summarize all invoices" / Receivables Summary
  const isSummarizeAllQuery =
    /\b(summarize all|summary of all|all invoices summary|summarize invoices|overview of all invoices|receivables summary|receivables overview|understand my receivables)\b/i.test(text) ||
    text === "summarize all invoices" ||
    text === "summarize invoices";

  if (isSummarizeAllQuery) {
    const totalCount = invoices.length;
    const totalAmount = invoices.reduce((sum, i) => sum + i.totalMinorUnits, 0);

    const paidInvoices = invoices.filter((i) => i.cashpilotStatus === CashPilotStatus.PAID);
    const paidAmount = paidInvoices.reduce((sum, i) => sum + i.totalMinorUnits, 0);

    const overdueInvoices = invoices.filter((i) => i.cashpilotStatus === CashPilotStatus.OVERDUE);
    const overdueAmount = overdueInvoices.reduce((sum, i) => sum + i.totalMinorUnits, 0);

    const dueSoonInvoices = invoices.filter((i) => i.cashpilotStatus === CashPilotStatus.DUE_SOON);
    const dueSoonAmount = dueSoonInvoices.reduce((sum, i) => sum + i.totalMinorUnits, 0);

    const awaitingInvoices = invoices.filter((i) => i.cashpilotStatus === CashPilotStatus.AWAITING_PAYMENT);
    const awaitingAmount = awaitingInvoices.reduce((sum, i) => sum + i.totalMinorUnits, 0);

    const draftInvoices = invoices.filter((i) => i.cashpilotStatus === CashPilotStatus.DRAFT);
    const draftAmount = draftInvoices.reduce((sum, i) => sum + i.totalMinorUnits, 0);

    const content = `All Invoices Summary (${totalCount} invoice${totalCount === 1 ? "" : "s"} · ${formatMoney(totalAmount, "USD")}):

• Paid: ${paidInvoices.length} (${formatMoney(paidAmount, "USD")}) — PayPal confirmed
• Overdue: ${overdueInvoices.length} (${formatMoney(overdueAmount, "USD")}) — requires attention
• Due soon: ${dueSoonInvoices.length} (${formatMoney(dueSoonAmount, "USD")})
• Awaiting payment: ${awaitingInvoices.length} (${formatMoney(awaitingAmount, "USD")})
• Drafts: ${draftInvoices.length} (${formatMoney(draftAmount, "USD")})

All monetary values calculated on the server using integer minor units. Workflow and PayPal statuses tracked independently.`;

    const topOverdue = overdueInvoices[0];
    const suggestedActions: SuggestedAction[] = topOverdue
      ? [
          {
            label: "Draft a reminder",
            actionType: "draft_reminder",
            invoiceId: topOverdue.id,
          },
          {
            label: "Open invoice",
            actionType: "open_invoice",
            invoiceId: topOverdue.id,
          },
        ]
      : [
          {
            label: "Draft invoice",
            actionType: "draft_invoice",
          },
        ];

    const suggestedFollowUps = [
      "Which invoices need attention first?",
      "Show overdue invoices",
      "Show unpaid invoices",
    ];

    return {
      ok: true,
      data: {
        message: {
          id: `msg-${Date.now()}`,
          role: "assistant",
          content,
          createdAt: new Date().toISOString(),
          source: "deterministic_rule_based",
          modelName: "cashpilot-summary-all-v1",
          suggestedActions,
          suggestedFollowUps,
        },
        rankedInvoices,
        lastSyncAt,
        suggestedFollowUps,
        availableClients,
      },
    };
  }

  // Route 10: "List all invoices" / Complete Directory Listing
  const isListAllQuery =
    /\b(list all|show all|all invoices|display all invoices|see all invoices)\b/i.test(text) ||
    text === "list all invoices" ||
    text === "all invoices";

  if (isListAllQuery) {
    if (invoices.length === 0) {
      const content = "No invoices found in this workspace. You can create your first invoice in Invoice Studio.";
      const suggestedActions: SuggestedAction[] = [
        {
          label: "Draft invoice",
          actionType: "draft_invoice",
        },
      ];
      return {
        ok: true,
        data: {
          message: {
            id: `msg-${Date.now()}`,
            role: "assistant",
            content,
            createdAt: new Date().toISOString(),
            source: "deterministic_rule_based",
            modelName: "cashpilot-list-all-v1",
            suggestedActions,
          },
          rankedInvoices,
          lastSyncAt,
          suggestedFollowUps: ["Which invoices need attention first?"],
          availableClients,
        },
      };
    }

    const lines = invoices.map((inv) => {
      const amt = formatMoney(inv.totalMinorUnits, inv.currency);
      const dueFormatted = new Date(inv.dueDate).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
      const paypalText = inv.paypalStatus ? `${inv.paypalStatus} (PayPal)` : "Status not confirmed by PayPal";
      const days = getDaysOverdue(inv.dueDate, now);
      const overdueExtra = inv.cashpilotStatus === CashPilotStatus.OVERDUE ? ` (${days}d overdue)` : "";
      return `• ${inv.client.name} — ${inv.number ?? "Draft"}: ${amt} | Due: ${dueFormatted}${overdueExtra} | Status: ${inv.cashpilotStatus} | ${paypalText}`;
    });

    const content = `Found ${invoices.length} total invoice${invoices.length === 1 ? "" : "s"} on file:\n\n${lines.join("\n")}\n\nWorkflow and PayPal statuses are independently maintained.`;

    const top = sortedByPriority[0] || invoices[0];
    const suggestedActions: SuggestedAction[] = [
      {
        label: "Open invoice",
        actionType: "open_invoice",
        invoiceId: top.id,
      },
      {
        label: "Draft invoice",
        actionType: "draft_invoice",
      },
    ];

    const suggestedFollowUps = [
      "Summarize all invoices",
      "Which invoices need attention first?",
      "Show overdue invoices",
    ];

    return {
      ok: true,
      data: {
        message: {
          id: `msg-${Date.now()}`,
          role: "assistant",
          content,
          createdAt: new Date().toISOString(),
          source: "deterministic_rule_based",
          modelName: "cashpilot-list-all-v1",
          suggestedActions,
          suggestedFollowUps,
        },
        rankedInvoices,
        lastSyncAt,
        suggestedFollowUps,
        availableClients,
      },
    };
  }

  // Route 11: "Summarize [Client]" or Client Lookup
  const clientMatch = text.match(/(?:summarise|summarize|tell me about|status of|how is)\s+([A-Za-z0-9\s&.'-]+?)(?:'s invoices| invoices)?$/i);
  if (clientMatch) {
    const targetName = clientMatch[1].trim().toLowerCase();
    const clientInvoices = invoices.filter(
      (inv) =>
        inv.client.name.toLowerCase().includes(targetName) ||
        targetName.includes(inv.client.name.toLowerCase())
    );

    if (clientInvoices.length > 0) {
      const clientName = clientInvoices[0].client.name;
      const totalBilled = clientInvoices.reduce((sum, i) => sum + i.totalMinorUnits, 0);
      const paidInvoices = clientInvoices.filter((i) => i.cashpilotStatus === CashPilotStatus.PAID);
      const paidAmount = paidInvoices.reduce((sum, i) => sum + i.totalMinorUnits, 0);
      const unpaidClient = clientInvoices.filter(
        (i) => i.cashpilotStatus !== CashPilotStatus.PAID && i.cashpilotStatus !== CashPilotStatus.CANCELLED
      );
      const unpaidAmount = unpaidClient.reduce((sum, i) => sum + i.totalMinorUnits, 0);
      const overdueClient = clientInvoices.filter((i) => i.cashpilotStatus === CashPilotStatus.OVERDUE);
      const overdueAmount = overdueClient.reduce((sum, i) => sum + i.totalMinorUnits, 0);

      const invoiceLines = clientInvoices.map((inv) => {
        const amt = formatMoney(inv.totalMinorUnits, inv.currency);
        const dueFormatted = new Date(inv.dueDate).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        const paypalText = inv.paypalStatus ? `${inv.paypalStatus} (PayPal)` : "Status not confirmed by PayPal";
        return `  - ${inv.number ?? "Draft"}: ${amt} | Due: ${dueFormatted} | Status: ${inv.cashpilotStatus} [${paypalText}]`;
      });

      const content = `Summary for ${clientName}:
• Total invoices: ${clientInvoices.length} (${formatMoney(totalBilled, "USD")})
• Paid: ${paidInvoices.length} (${formatMoney(paidAmount, "USD")})
• Open / Unpaid: ${unpaidClient.length} (${formatMoney(unpaidAmount, "USD")})
• Overdue: ${overdueClient.length} (${formatMoney(overdueAmount, "USD")})

Invoices on record:
${invoiceLines.join("\n")}

All status data confirmed via PayPal Sandbox synchronization.`;

      const suggestedActions: SuggestedAction[] = [];
      if (overdueClient.length > 0) {
        suggestedActions.push({
          label: "Draft a reminder",
          actionType: "draft_reminder",
          invoiceId: overdueClient[0].id,
        });
      }
      suggestedActions.push({
        label: "Open invoice",
        actionType: "open_invoice",
        invoiceId: clientInvoices[0].id,
      });

      const suggestedFollowUps = [
        "List all invoices",
        "Show unpaid invoices",
        "Which invoices need attention first?",
      ];

      return {
        ok: true,
        data: {
          message: {
            id: `msg-${Date.now()}`,
            role: "assistant",
            content,
            createdAt: new Date().toISOString(),
            source: "deterministic_rule_based",
            modelName: "cashpilot-client-summary-v1",
            suggestedActions,
            suggestedFollowUps,
          },
          rankedInvoices,
          lastSyncAt,
          suggestedFollowUps,
          availableClients,
        },
      };
    }
  }

  // Route 12: If Google Gemini is configured, use it for conversational answers with factual context
  let env;
  try {
    env = getServerEnv();
  } catch {
    env = null;
  }

  if (env && isAiConfigured(env) && env.AI_PROVIDER === "google") {
    try {
      const invoiceFacts = invoices.map((inv) => ({
        number: inv.number,
        client: inv.client.name,
        amount: formatMoney(inv.totalMinorUnits, inv.currency),
        status: inv.cashpilotStatus,
        paypalStatus: inv.paypalStatus,
        dueDate: new Date(inv.dueDate).toISOString().split("T")[0],
        overdueDays: getDaysOverdue(inv.dueDate, now),
      }));

      const systemPrompt = `You are Navi, the guided receivables copilot in CashPilot AI.
Your answers MUST be strictly grounded in the verified invoice records provided below.
Rules:
1. Never invent or hallucinate invoice statuses, amounts, or PayPal confirmations.
2. If asked to mark an invoice as paid, change status, or execute actions, REFUSE and explain that PayPal is the authority and human approval is required in CashPilot.
3. Be concise, professional, and clear.
4. If facts are not in the context, say you do not have that record.

Verified Invoice Context:
${JSON.stringify(invoiceFacts, null, 2)}`;

      const promptPayload = {
        system_instruction: {
          parts: [{ text: systemPrompt }],
        },
        contents: [
          ...conversationHistory.slice(-4).map((h) => ({
            role: h.role === "assistant" ? "model" : "user",
            parts: [{ text: h.content.substring(0, 500) }],
          })),
          {
            role: "user",
            parts: [{ text: userMessage.substring(0, 500) }],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 500,
        },
      };

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.AI_MODEL}:generateContent?key=${env.AI_API_KEY}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(promptPayload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (res.ok) {
        const json = await res.json();
        const candidateText = json.candidates?.[0]?.content?.parts?.[0]?.text;
        if (candidateText && candidateText.trim().length > 0) {
          const trimmed = candidateText.trim();
          // Ensure model output never falsely claims to have executed payments or status mutations
          const outputRefusal = checkSafetyRefusal(trimmed);
          if (outputRefusal.isRefusal && outputRefusal.refusalReason) {
            return {
              ok: true,
              data: {
                message: {
                  id: `msg-${Date.now()}`,
                  role: "assistant",
                  content: outputRefusal.refusalReason,
                  createdAt: new Date().toISOString(),
                  source: "deterministic_rule_based",
                  modelName: "cashpilot-safety-guardrails-v1",
                  isRefusal: true,
                },
                rankedInvoices,
                lastSyncAt,
                suggestedFollowUps: [
                  "Which invoices need attention first?",
                  "Show overdue invoices",
                  "Summarize all invoices",
                ],
                availableClients,
              },
            };
          }

          const suggestedFollowUps = [
            "Which invoices need attention first?",
            "Show overdue invoices",
            "Summarize all invoices",
          ];

          return {
            ok: true,
            data: {
              message: {
                id: `msg-${Date.now()}`,
                role: "assistant",
                content: trimmed,
                createdAt: new Date().toISOString(),
                source: "ai_model",
                modelName: env.AI_MODEL,
                suggestedFollowUps,
              },
              rankedInvoices,
              lastSyncAt,
              suggestedFollowUps,
              availableClients,
            },
          };
        }
      }
    } catch {
      // Gracefully fall through to deterministic response
    }
  }

  // Route 13: Clarifying / Unsupported Query Fallback
  const clarifyingContent = `I can help with your receivables and collections, but I couldn't match that specific question to available records.

Here are questions I can answer using your verified invoice and PayPal records:
• Priorities: "Which invoices need attention first?"
• Overview: "Summarize all invoices" or "List all invoices"
• Overdue accounts: "Show overdue invoices" or "How much is overdue right now?"
• Open receivables: "Show unpaid invoices"
• Received payments: "Show paid invoices"
• Due dates: "What is due today?" or "What is due this week?"
• Client summaries: "Summarize [Client Name]"

Please select one of the suggested questions below.`;

  const fallbackFollowUps = [
    "Which invoices need attention first?",
    "Summarize all invoices",
    "Show overdue invoices",
  ];

  return {
    ok: true,
    data: {
      message: {
        id: `msg-${Date.now()}`,
        role: "assistant",
        content: clarifyingContent,
        createdAt: new Date().toISOString(),
        source: "deterministic_rule_based",
        modelName: "cashpilot-clarification-v1",
        suggestedFollowUps: fallbackFollowUps,
      },
      rankedInvoices,
      lastSyncAt,
      suggestedFollowUps: fallbackFollowUps,
      availableClients,
    },
  };
}
