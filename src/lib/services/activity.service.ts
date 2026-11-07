/**
 * CashPilot AI — Workspace Activity & Audit Service
 *
 * SRS §4, §5 & UI Design Reference Page 15:
 * Permanent append-only record of proposals, human approvals, provider calls, and reconciliations.
 *
 * Invariants:
 * - Append-only integrity: activity events are never mutated or deleted.
 * - Zero secrets logged: tokens, passwords, and payment credentials are never stored or returned.
 * - Tenant isolation: queries are strictly scoped to the authorized workspace.
 * - Explains end-to-end trace: connects natural-language prompt -> AI draft -> user approval -> PayPal execution.
 */

import { db } from "@/lib/db/client";
import {
  ActivityEventType,
  ActorType,
  CashPilotStatus,
  Prisma,
} from "@prisma/client";
import { minorUnitsToDecimalString } from "@/lib/money";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type OutcomeBadgeVariant =
  | "confirmed"   // Confirmed by PayPal (green)
  | "approved"    // Approved by human (emerald)
  | "proposed"    // AI proposed (violet/purple)
  | "partial"     // Partial / some need review (amber)
  | "rejected"    // Rejected / blocked / invalidated (rose/red)
  | "unknown"     // Was unknown / timed out (orange)
  | "neutral";    // Standard information / lifecycle (slate/gray)

export interface OutcomeBadge {
  label: string;
  variant: OutcomeBadgeVariant;
}

export interface ActivityItem {
  id: string;
  eventType: ActivityEventType;
  actorType: ActorType;
  actorLabel: string; // "You" | "Navi" | "App" | "System" | "PayPal"
  title: string;
  subtitle: string;
  description: string;
  outcomeBadge: OutcomeBadge;
  createdAt: string; // ISO string
  timeFormatted: string; // e.g., "23:24"
  dateFormatted: string; // e.g., "Friday, Oct 16"
  dateGroupKey: string; // e.g., "Today · Friday 16 October"
  invoiceId: string | null;
  invoiceNumber: string | null;
  clientName: string | null;
  amountFormatted: string | null; // e.g., "$1,200.00"
  currency: string | null;
  metadata: Record<string, unknown> | null;
}

export interface ActivityFilterOptions {
  type?: "all" | "ai" | "approval" | "operation" | "sync" | "security";
  result?: "all" | "confirmed" | "approved" | "proposed" | "partial" | "rejected" | "unknown";
  invoiceId?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface InvoiceJourneyStep {
  stepNumber: number; // 1 to 5
  title: string;
  badgeLabel?: string;
  badgeVariant?: OutcomeBadgeVariant;
  summary: string;
  timestamp?: string | null;
  status: "completed" | "in_progress" | "pending" | "flagged";
  details?: string | null;
}

export interface InvoiceJourneyTrace {
  invoiceId: string;
  invoiceNumber: string;
  clientName: string;
  totalMinorUnits: number;
  totalFormatted: string;
  currency: string;
  cashpilotStatus: string;
  paypalStatus: string | null;
  paypalInvoiceId: string | null;
  steps: InvoiceJourneyStep[];
}

export interface InvoiceSelectorOption {
  id: string;
  number: string;
  clientName: string;
  status: string;
  totalFormatted: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Format Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDateGroup(date: Date): string {
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();

  const weekday = date.toLocaleDateString("en-US", { weekday: "long" });
  const day = date.getDate();
  const month = date.toLocaleDateString("en-US", { month: "long" });

  if (isToday) {
    return `Today · ${weekday} ${day} ${month}`;
  }
  if (isYesterday) {
    return `Yesterday · ${weekday} ${day} ${month}`;
  }
  return `${weekday} ${day} ${month} ${date.getFullYear()}`;
}

function truncateHash(hash?: string | null): string {
  if (!hash) return "";
  if (hash.length <= 12) return hash;
  return `${hash.slice(0, 4)}…${hash.slice(-4)}`;
}

function truncateId(id?: string | null): string {
  if (!id) return "";
  if (id.length <= 14) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

export function deriveOutcomeBadge(
  eventType: ActivityEventType,
  actorType: ActorType,
  description: string,
  metadata?: Prisma.JsonValue
): OutcomeBadge {
  const descLower = description.toLowerCase();
  const meta = (metadata as Record<string, unknown>) || {};
  const providerStatus = typeof meta.providerStatus === "string" ? meta.providerStatus.trim().toUpperCase() : "";
  const cashpilotStatus = typeof meta.cashpilotStatus === "string" ? meta.cashpilotStatus.trim().toUpperCase() : "";

  // 1. Blocked or rejected events
  if (
    eventType === ActivityEventType.APPROVAL_INVALIDATED ||
    eventType === ActivityEventType.APPROVAL_EXPIRED ||
    providerStatus === "CANCELLED" ||
    providerStatus === "VOIDED" ||
    descLower.includes("blocked") ||
    descLower.includes("rejected") ||
    descLower.includes("denied") ||
    descLower.includes("forbidden")
  ) {
    return { label: "Rejected", variant: "rejected" };
  }

  // 2. Timed out or unknown outcome
  if (
    eventType === ActivityEventType.OPERATION_TIMED_OUT ||
    meta.isOutcomeUnknown === true ||
    descLower.includes("timed out") ||
    descLower.includes("was unknown")
  ) {
    return { label: "Was unknown", variant: "unknown" };
  }

  // 3. Failed operations
  if (
    eventType === ActivityEventType.OPERATION_FAILED ||
    eventType === ActivityEventType.STATUS_SYNC_FAILED
  ) {
    return { label: "Failed", variant: "rejected" };
  }

  // 4. Multi-invoice partial reconciliation, partial payments, or refunds requiring review
  if (
    (eventType === ActivityEventType.STATUS_SYNC_SUCCESS || eventType === ActivityEventType.STATUS_SYNC_RECONCILED) &&
    (
      (meta.staleCount as number) > 0 ||
      providerStatus === "PARTIALLY_PAID" ||
      providerStatus === "REFUNDED" ||
      providerStatus === "PARTIALLY_REFUNDED" ||
      descLower.includes("needs review") ||
      descLower.includes("couldn't be reached")
    )
  ) {
    return { label: "Partial", variant: "partial" };
  }

  // 5. Verified PayPal operations & payment confirmations
  if (
    eventType === ActivityEventType.OPERATION_SUCCEEDED ||
    eventType === ActivityEventType.STATUS_SYNC_RECONCILED ||
    providerStatus === "PAID" ||
    cashpilotStatus === "PAID" ||
    descLower.includes("confirmed by paypal") ||
    descLower.includes("payment confirmed") ||
    descLower.includes("paypal draft created") ||
    descLower.includes("sent via paypal") ||
    descLower.includes("paid via paypal")
  ) {
    return { label: "Confirmed by PayPal", variant: "confirmed" };
  }

  // 6. User approvals
  if (eventType === ActivityEventType.APPROVAL_APPROVED) {
    return { label: "Approved", variant: "approved" };
  }

  // 7. AI proposals
  if (
    actorType === ActorType.AI ||
    eventType === ActivityEventType.AI_DRAFT_GENERATED ||
    descLower.includes("drafted from your request") ||
    descLower.includes("ai proposed")
  ) {
    return { label: "AI proposed", variant: "proposed" };
  }

  // 8. General success or fallback
  return { label: "Logged", variant: "neutral" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Service Methods
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Retrieves the workspace activity feed with pagination, search, and filtering.
 */
export async function getWorkspaceActivityFeed(
  workspaceId: string,
  actorId: string,
  options: ActivityFilterOptions = {}
): Promise<{
  items: ActivityItem[];
  totalCount: number;
  hasMore: boolean;
}> {
  // 1. Authorize workspace access
  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, ownerId: true },
  });

  if (!workspace || workspace.ownerId !== actorId) {
    throw new Error("Unauthorized workspace access");
  }

  // 2. Build Prisma where clause
  const where: Prisma.ActivityEventWhereInput = {
    workspaceId,
  };

  if (options.invoiceId) {
    where.invoiceId = options.invoiceId;
  }

  // Filter by Type
  if (options.type && options.type !== "all") {
    switch (options.type) {
      case "ai":
        where.OR = [
          { actorType: ActorType.AI },
          {
            eventType: {
              in: [
                ActivityEventType.AI_DRAFT_GENERATED,
                ActivityEventType.AI_DRAFT_ACCEPTED,
                ActivityEventType.AI_DRAFT_REJECTED,
              ],
            },
          },
        ];
        break;
      case "approval":
        where.eventType = {
          in: [
            ActivityEventType.APPROVAL_CREATED,
            ActivityEventType.APPROVAL_APPROVED,
            ActivityEventType.APPROVAL_INVALIDATED,
            ActivityEventType.APPROVAL_EXPIRED,
          ],
        };
        break;
      case "operation":
        where.eventType = {
          in: [
            ActivityEventType.OPERATION_ATTEMPTED,
            ActivityEventType.OPERATION_SUCCEEDED,
            ActivityEventType.OPERATION_FAILED,
            ActivityEventType.OPERATION_TIMED_OUT,
          ],
        };
        break;
      case "sync":
        where.eventType = {
          in: [
            ActivityEventType.STATUS_SYNC_SUCCESS,
            ActivityEventType.STATUS_SYNC_FAILED,
            ActivityEventType.STATUS_SYNC_RECONCILED,
          ],
        };
        break;
      case "security":
        where.OR = [
          { eventType: ActivityEventType.SYSTEM_EVENT },
          { description: { contains: "blocked", mode: "insensitive" } },
        ];
        break;
    }
  }

  // Filter by Result / Outcome
  if (options.result && options.result !== "all") {
    switch (options.result) {
      case "confirmed":
        where.eventType = ActivityEventType.OPERATION_SUCCEEDED;
        break;
      case "approved":
        where.eventType = ActivityEventType.APPROVAL_APPROVED;
        break;
      case "proposed":
        where.eventType = ActivityEventType.AI_DRAFT_GENERATED;
        break;
      case "partial":
        where.eventType = ActivityEventType.STATUS_SYNC_SUCCESS;
        break;
      case "rejected":
        where.OR = [
          { eventType: ActivityEventType.APPROVAL_INVALIDATED },
          { description: { contains: "blocked", mode: "insensitive" } },
        ];
        break;
      case "unknown":
        where.eventType = ActivityEventType.OPERATION_TIMED_OUT;
        break;
    }
  }

  // Optional search query on description or invoice number
  if (options.search && options.search.trim().length > 0) {
    const q = options.search.trim();
    where.AND = [
      {
        OR: [
          { description: { contains: q, mode: "insensitive" } },
          { invoice: { number: { contains: q, mode: "insensitive" } } },
          { invoice: { client: { name: { contains: q, mode: "insensitive" } } } },
        ],
      },
    ];
  }

  const limit = Math.min(options.limit ?? 50, 100);
  const offset = options.offset ?? 0;

  // 3. Query count and records in parallel
  const [totalCount, rawEvents] = await Promise.all([
    db.activityEvent.count({ where }),
    db.activityEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      include: {
        invoice: {
          select: {
            id: true,
            number: true,
            totalMinorUnits: true,
            currency: true,
            cashpilotStatus: true,
            paypalInvoiceId: true,
            client: {
              select: { name: true },
            },
          },
        },
        approval: {
          select: {
            payloadHash: true,
            actionType: true,
            status: true,
          },
        },
        operation: {
          select: {
            providerInvoiceId: true,
            operationType: true,
            attemptState: true,
          },
        },
      },
    }),
  ]);

  // 4. Transform to serialized view models
  const items: ActivityItem[] = rawEvents.map((act) => {
    const meta = (act.metadata as Record<string, unknown>) || {};
    const invoiceNum = act.invoice?.number ?? null;
    const clientName = act.invoice?.client?.name ?? (meta.clientName as string) ?? null;

    let actorLabel = "System";
    if (act.actorType === ActorType.USER) actorLabel = "You";
    else if (act.actorType === ActorType.AI) actorLabel = "Navi";
    else if (act.operation?.providerInvoiceId || act.eventType === ActivityEventType.OPERATION_SUCCEEDED) {
      actorLabel = "PayPal";
    }

    // Compose concise headline title (Page 15 design)
    let title = act.description;
    let subtitle = "";

    switch (act.eventType) {
      case ActivityEventType.STATUS_SYNC_SUCCESS:
      case ActivityEventType.STATUS_SYNC_RECONCILED: {
        const isBatch =
          !act.invoiceId ||
          meta.totalInvoicesScanned !== undefined ||
          meta.totalPaypalInvoicesQueried !== undefined ||
          meta.totalQueried !== undefined ||
          meta.totalScanned !== undefined;

        if (isBatch) {
          title = `Status refreshed · ${meta.totalQueried ?? meta.totalScanned ?? meta.totalPaypalInvoicesQueried ?? "all"} invoices`;
          subtitle = `System · ${meta.staleCount ?? 0} needs review, ${meta.changedCount ?? 0} updated`;
        } else {
          // Single-invoice sync
          const providerStatus = (meta.providerStatus as string)?.trim().toUpperCase();
          const cashpilotStatus =
            (meta.cashpilotStatus as string)?.trim().toUpperCase() ??
            act.invoice?.cashpilotStatus;
          const statusChanged = Boolean(meta.statusChanged);
          const formattedAmt = act.invoice?.totalMinorUnits
            ? `$${minorUnitsToDecimalString(act.invoice.totalMinorUnits)}`
            : "";
          const clientTarget = clientName ? ` by ${clientName}` : "";

          if (statusChanged && (cashpilotStatus === "PAID" || providerStatus === "PAID")) {
            title = `Payment confirmed via PayPal · ${invoiceNum ?? "INV"}`;
            subtitle = formattedAmt
              ? `PayPal · ${formattedAmt} confirmed paid${clientTarget}`
              : `PayPal · Payment confirmed${clientTarget}`;
          } else if (!statusChanged && (cashpilotStatus === "PAID" || providerStatus === "PAID")) {
            title = `Status verified · ${invoiceNum ?? "INV"}`;
            subtitle = "PayPal · Payment status remains confirmed (PAID)";
          } else if (statusChanged && providerStatus === "PARTIALLY_PAID") {
            title = `Partial payment reported · ${invoiceNum ?? "INV"}`;
            subtitle = "PayPal · Requires review by you";
          } else if (
            statusChanged &&
            providerStatus &&
            ["REFUNDED", "PARTIALLY_REFUNDED"].includes(providerStatus)
          ) {
            title = `Refund reported · ${invoiceNum ?? "INV"}`;
            subtitle = `PayPal · Status updated to ${providerStatus} (requires review)`;
          } else if (
            statusChanged &&
            providerStatus &&
            ["CANCELLED", "VOIDED"].includes(providerStatus)
          ) {
            title = `Invoice cancelled · ${invoiceNum ?? "INV"}`;
            subtitle = "PayPal · Cancelled on PayPal Sandbox";
          } else if (!statusChanged) {
            title = `Status verified · ${invoiceNum ?? "INV"}`;
            subtitle = `PayPal · Status unchanged (${providerStatus ?? "SENT"})`;
          } else {
            title = `Status refreshed · ${invoiceNum ?? "INV"}`;
            subtitle = `PayPal · Provider status: ${providerStatus ?? "confirmed"}`;
          }
        }
        break;
      }

      case ActivityEventType.STATUS_SYNC_FAILED:
        if (act.invoiceId) {
          title = `Sync failed · ${invoiceNum ?? "INV"}`;
          subtitle = "PayPal · Last known status preserved";
        } else {
          title = "Status refresh failed";
          subtitle = `System · ${act.description}`;
        }
        break;

      case ActivityEventType.OPERATION_SUCCEEDED:
        if (act.operation?.operationType === "SEND_INVOICE" || act.description.includes("sent")) {
          title = `Invoice sent via PayPal · ${invoiceNum ?? "INV"}`;
          const formattedAmt = act.invoice?.totalMinorUnits
            ? `$${minorUnitsToDecimalString(act.invoice.totalMinorUnits)}`
            : "";
          subtitle = `You · ${formattedAmt} to ${clientName ?? "Client"}`;
        } else if (act.operation?.operationType === "CREATE_DRAFT" || act.description.includes("draft")) {
          title = `PayPal draft created · ${invoiceNum ?? "INV"}`;
          subtitle = `App · ID ${truncateId(act.invoice?.paypalInvoiceId ?? act.operation?.providerInvoiceId)} saved`;
        } else if (act.operation?.operationType === "SEND_REMINDER") {
          title = `Payment reminder sent · ${invoiceNum ?? "INV"}`;
          subtitle = `You · Confirmed by PayPal to ${clientName ?? "Client"}`;
        } else {
          title = act.description;
          subtitle = `${actorLabel} · Confirmed by PayPal`;
        }
        break;

      case ActivityEventType.APPROVAL_APPROVED:
        title = `You approved sending · ${invoiceNum ?? "INV"}`;
        subtitle = `Locked to version ${truncateHash(act.approval?.payloadHash ?? (meta.payloadHash as string))}`;
        break;

      case ActivityEventType.AI_DRAFT_GENERATED:
        title = "Invoice drafted from your request";
        subtitle = `Navi · ${meta.missingFieldsCount ?? "Fields"} flagged for review`;
        break;

      case ActivityEventType.SYSTEM_EVENT:
        if (act.description.toLowerCase().includes("blocked")) {
          title = "AI request blocked";
          subtitle = `System · ${act.description}`;
        } else {
          title = act.description;
          subtitle = "System event";
        }
        break;

      case ActivityEventType.OPERATION_TIMED_OUT:
        title = `Send timed out · ${invoiceNum ?? "INV"}`;
        subtitle = `App · ${act.description}`;
        break;

      default:
        title = act.description;
        subtitle = `${actorLabel} · ${invoiceNum ? `Target: ${invoiceNum}` : "Workspace activity"}`;
        break;
    }

    const outcomeBadge = deriveOutcomeBadge(
      act.eventType,
      act.actorType,
      `${title} ${act.description}`,
      act.metadata
    );

    const amountFormatted = act.invoice?.totalMinorUnits
      ? `$${minorUnitsToDecimalString(act.invoice.totalMinorUnits)}`
      : null;

    return {
      id: act.id,
      eventType: act.eventType,
      actorType: act.actorType,
      actorLabel,
      title,
      subtitle,
      description: act.description,
      outcomeBadge,
      createdAt: act.createdAt.toISOString(),
      timeFormatted: formatTime(act.createdAt),
      dateFormatted: act.createdAt.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      }),
      dateGroupKey: formatDateGroup(act.createdAt),
      invoiceId: act.invoiceId,
      invoiceNumber: invoiceNum,
      clientName,
      amountFormatted,
      currency: act.invoice?.currency ?? "USD",
      metadata: meta,
    };
  });

  return {
    items,
    totalCount,
    hasMore: offset + items.length < totalCount,
  };
}

/**
 * Reconstructs the 5-step lifecycle journey for a target invoice.
 * UI Design Reference Page 15: "Follow one invoice end to end"
 */
export async function getInvoiceEndToEndTrace(
  workspaceId: string,
  invoiceId: string
): Promise<InvoiceJourneyTrace | null> {
  const invoice = await db.invoice.findFirst({
    where: { id: invoiceId, workspaceId },
    include: {
      client: { select: { name: true } },
      approvals: {
        orderBy: { createdAt: "desc" },
        take: 1,
      },
      operations: {
        orderBy: { createdAt: "desc" },
      },
      activities: {
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!invoice) return null;

  // Retrieve matching AiDraft if referenced
  let aiDraft = null;
  if (invoice.aiDraftId) {
    aiDraft = await db.aiDraft.findUnique({
      where: { id: invoice.aiDraftId },
    });
  } else {
    // Attempt fallback lookup by invoiceId
    aiDraft = await db.aiDraft.findFirst({
      where: { invoiceId: invoice.id, workspaceId },
    });
  }

  const steps: InvoiceJourneyStep[] = [];

  // 1. Step 1: Your request
  const requestPrompt =
    aiDraft?.inputText ??
    (invoice.notes ? `"${invoice.notes}"` : `Invoice creation requested for ${invoice.client.name}`);

  steps.push({
    stepNumber: 1,
    title: "Your request",
    summary: requestPrompt,
    timestamp: (aiDraft?.createdAt ?? invoice.createdAt).toISOString(),
    status: "completed",
    details: "Natural language input captured in workspace",
  });

  // 2. Step 2: Navi's draft (AI)
  const aiActivity = invoice.activities.find(
    (a) => a.eventType === ActivityEventType.AI_DRAFT_GENERATED
  );
  const aiMeta = (aiActivity?.metadata as Record<string, unknown>) || {};
  const flaggedDetails =
    (aiMeta.flaggedReasons as string) ??
    (aiDraft ? "Email and due date flagged for confirmation" : "Structured invoice fields drafted");

  steps.push({
    stepNumber: 2,
    title: "Navi's draft",
    badgeLabel: "AI",
    badgeVariant: "proposed",
    summary: flaggedDetails,
    timestamp: (aiDraft?.createdAt ?? aiActivity?.createdAt ?? invoice.createdAt).toISOString(),
    status: "completed",
    details: "Extracted without inventing client email or payment terms",
  });

  // 3. Step 3: Your edits
  const invoiceCreatedActivity = invoice.activities.find(
    (a) => a.eventType === ActivityEventType.INVOICE_CREATED || a.eventType === ActivityEventType.INVOICE_UPDATED
  );
  steps.push({
    stepNumber: 3,
    title: "Your edits",
    summary: "Recipient verified, due date confirmed, total calculated",
    timestamp: (invoiceCreatedActivity?.createdAt ?? invoice.createdAt).toISOString(),
    status: "completed",
    details: `Authoritative server total: $${minorUnitsToDecimalString(invoice.totalMinorUnits)} ${invoice.currency}`,
  });

  // 4. Step 4: Your approval (You)
  const latestApproval = invoice.approvals[0];
  if (latestApproval && latestApproval.status === "APPROVED") {
    const timeStr = formatTime(latestApproval.approvedAt ?? latestApproval.createdAt);
    steps.push({
      stepNumber: 4,
      title: "Your approval",
      badgeLabel: "You",
      badgeVariant: "approved",
      summary: `${timeStr} · version ${truncateHash(latestApproval.payloadHash)}`,
      timestamp: (latestApproval.approvedAt ?? latestApproval.createdAt).toISOString(),
      status: "completed",
      details: "Approval bound to exact material SHA-256 payload hash",
    });
  } else {
    steps.push({
      stepNumber: 4,
      title: "Your approval",
      badgeLabel: "You",
      badgeVariant: "neutral",
      summary: "Awaiting explicit human approval",
      status: "pending",
      details: "Consequential PayPal execution requires explicit user authorization",
    });
  }

  // 5. Step 5: PayPal's response (PayPal)
  const sendOp = invoice.operations.find(
    (op) =>
      op.operationType === "SEND_INVOICE" &&
      (op.attemptState === "SUCCESS" || (op.attemptState as string) === "SUCCEEDED")
  );
  const draftOp = invoice.operations.find(
    (op) =>
      op.operationType === "CREATE_DRAFT" &&
      (op.attemptState === "SUCCESS" || (op.attemptState as string) === "SUCCEEDED")
  );

  const rawPaypalStatus = invoice.paypalStatus?.trim().toUpperCase();
  const rawCashpilotStatus = invoice.cashpilotStatus;
  const isTransmitted = Boolean(sendOp || draftOp || invoice.paypalInvoiceId);

  if (!isTransmitted) {
    steps.push({
      stepNumber: 5,
      title: "PayPal's response",
      badgeLabel: "PayPal",
      badgeVariant: "neutral",
      summary: "Not yet transmitted to PayPal Sandbox",
      status: "pending",
      details: "No network writes performed prior to approval",
    });
  } else if (invoice.syncIsStale) {
    const timeStr = formatTime(invoice.lastSyncAt ?? sendOp?.completedAt ?? invoice.updatedAt);
    steps.push({
      stepNumber: 5,
      title: "PayPal's response",
      badgeLabel: "PayPal",
      badgeVariant: "unknown",
      summary: `${timeStr} · sync failed, last known status preserved`,
      timestamp: (invoice.lastSyncAt ?? sendOp?.completedAt ?? invoice.updatedAt).toISOString(),
      status: "flagged",
      details: `Provider ID: ${invoice.paypalInvoiceId ?? sendOp?.providerInvoiceId ?? "Unknown"}${rawPaypalStatus ? ` · Last known status: ${rawPaypalStatus}` : ""}`,
    });
  } else if (
    invoice.paymentProvenance === "SIMULATED_DEMO_PAYMENT" ||
    rawCashpilotStatus === CashPilotStatus.SIMULATED_PAID
  ) {
    const timeStr = formatTime(
      invoice.simulatedPaymentAt ?? invoice.updatedAt
    );
    steps.push({
      stepNumber: 5,
      title: "Payment simulation (Demo)",
      badgeLabel: "Simulated",
      badgeVariant: "confirmed",
      summary: `${timeStr} · payment simulated (no real money moved)`,
      timestamp: (invoice.simulatedPaymentAt ?? invoice.updatedAt).toISOString(),
      status: "completed",
      details: `Simulation Ref: ${invoice.simulatedRef ?? "SIM-DEMO"} · Demo simulation only · No PayPal API calls executed`,
    });
  } else if (rawPaypalStatus === "PAID" || rawCashpilotStatus === CashPilotStatus.PAID) {
    const timeStr = formatTime(invoice.lastSyncAt ?? sendOp?.completedAt ?? invoice.updatedAt);
    steps.push({
      stepNumber: 5,
      title: "PayPal's response",
      badgeLabel: "PayPal",
      badgeVariant: "confirmed",
      summary: `${timeStr} · payment verified (PAID)`,
      timestamp: (invoice.lastSyncAt ?? sendOp?.completedAt ?? invoice.updatedAt).toISOString(),
      status: "completed",
      details: `Provider ID: ${invoice.paypalInvoiceId ?? sendOp?.providerInvoiceId}`,
    });
  } else if (rawPaypalStatus === "PARTIALLY_PAID") {
    const timeStr = formatTime(invoice.lastSyncAt ?? sendOp?.completedAt ?? invoice.updatedAt);
    steps.push({
      stepNumber: 5,
      title: "PayPal's response",
      badgeLabel: "PayPal",
      badgeVariant: "partial",
      summary: `${timeStr} · partial payment received (PARTIALLY_PAID)`,
      timestamp: (invoice.lastSyncAt ?? sendOp?.completedAt ?? invoice.updatedAt).toISOString(),
      status: "flagged",
      details: `Provider ID: ${invoice.paypalInvoiceId ?? sendOp?.providerInvoiceId} · Requires review`,
    });
  } else if (
    rawPaypalStatus &&
    ["REFUNDED", "PARTIALLY_REFUNDED", "MARKED_AS_PAID", "MARKED_AS_REFUNDED"].includes(rawPaypalStatus)
  ) {
    const timeStr = formatTime(invoice.lastSyncAt ?? sendOp?.completedAt ?? invoice.updatedAt);
    steps.push({
      stepNumber: 5,
      title: "PayPal's response",
      badgeLabel: "PayPal",
      badgeVariant: "partial",
      summary: `${timeStr} · provider status ${rawPaypalStatus}`,
      timestamp: (invoice.lastSyncAt ?? sendOp?.completedAt ?? invoice.updatedAt).toISOString(),
      status: "flagged",
      details: `Provider ID: ${invoice.paypalInvoiceId ?? sendOp?.providerInvoiceId} · Requires review`,
    });
  } else if (rawPaypalStatus && ["CANCELLED", "VOIDED"].includes(rawPaypalStatus)) {
    const timeStr = formatTime(invoice.lastSyncAt ?? sendOp?.completedAt ?? invoice.updatedAt);
    steps.push({
      stepNumber: 5,
      title: "PayPal's response",
      badgeLabel: "PayPal",
      badgeVariant: "rejected",
      summary: `${timeStr} · invoice cancelled (${rawPaypalStatus})`,
      timestamp: (invoice.lastSyncAt ?? sendOp?.completedAt ?? invoice.updatedAt).toISOString(),
      status: "completed",
      details: `Provider ID: ${invoice.paypalInvoiceId ?? sendOp?.providerInvoiceId}`,
    });
  } else if (sendOp || rawPaypalStatus === "SENT" || rawCashpilotStatus === CashPilotStatus.AWAITING_PAYMENT) {
    const timeStr = formatTime(sendOp?.completedAt ?? invoice.lastSyncAt ?? sendOp?.createdAt ?? invoice.updatedAt);
    steps.push({
      stepNumber: 5,
      title: "PayPal's response",
      badgeLabel: "PayPal",
      badgeVariant: "confirmed",
      summary: `${timeStr} · accepted, status SENT`,
      timestamp: (sendOp?.completedAt ?? invoice.lastSyncAt ?? sendOp?.createdAt ?? invoice.updatedAt).toISOString(),
      status: "completed",
      details: `Provider ID: ${invoice.paypalInvoiceId ?? sendOp?.providerInvoiceId}`,
    });
  } else if (draftOp || rawPaypalStatus === "DRAFT") {
    const timeStr = formatTime(draftOp?.completedAt ?? draftOp?.createdAt ?? invoice.updatedAt);
    steps.push({
      stepNumber: 5,
      title: "PayPal's response",
      badgeLabel: "PayPal",
      badgeVariant: "confirmed",
      summary: `${timeStr} · draft created on PayPal`,
      timestamp: (draftOp?.completedAt ?? draftOp?.createdAt ?? invoice.updatedAt).toISOString(),
      status: "in_progress",
      details: `Draft ID: ${draftOp?.providerInvoiceId ?? invoice.paypalInvoiceId}`,
    });
  } else {
    const timeStr = formatTime(invoice.lastSyncAt ?? invoice.updatedAt);
    steps.push({
      stepNumber: 5,
      title: "PayPal's response",
      badgeLabel: "PayPal",
      badgeVariant: "neutral",
      summary: `${timeStr} · status recorded (${rawPaypalStatus ?? "unknown"})`,
      timestamp: (invoice.lastSyncAt ?? invoice.updatedAt).toISOString(),
      status: "completed",
      details: `Provider ID: ${invoice.paypalInvoiceId}`,
    });
  }

  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.number ?? "DRAFT",
    clientName: invoice.client.name,
    totalMinorUnits: invoice.totalMinorUnits,
    totalFormatted: `$${minorUnitsToDecimalString(invoice.totalMinorUnits)}`,
    currency: invoice.currency,
    cashpilotStatus: invoice.cashpilotStatus,
    paypalStatus: invoice.paypalStatus,
    paypalInvoiceId: invoice.paypalInvoiceId,
    steps,
  };
}

/**
 * Returns a list of workspace invoices for the "Follow one invoice end to end" selector.
 */
export async function getWorkspaceInvoicesForActivitySelector(
  workspaceId: string
): Promise<InvoiceSelectorOption[]> {
  const invoices = await db.invoice.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      number: true,
      totalMinorUnits: true,
      currency: true,
      cashpilotStatus: true,
      client: {
        select: { name: true },
      },
    },
    take: 20,
  });

  return invoices.map((inv) => ({
    id: inv.id,
    number: inv.number ?? "Draft",
    clientName: inv.client.name,
    status: inv.cashpilotStatus,
    totalFormatted: `$${minorUnitsToDecimalString(inv.totalMinorUnits)}`,
  }));
}
