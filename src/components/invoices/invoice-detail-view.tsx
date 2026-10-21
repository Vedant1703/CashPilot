"use client";

import React, { useState } from "react";
import Link from "next/link";
import { CashPilotStatus, type Prisma } from "@prisma/client";
import { StatusBadge } from "@/components/invoices/status-badge";
import { NaviAvatar, NaviState } from "@/components/navi/navi-avatar";
import { formatMoney } from "@/lib/money";
import { getInvoiceProvenance } from "@/lib/dashboard/metrics";
import {
  ArrowLeft,
  Building,
  Mail,
  Phone,
  RefreshCw,
  ShieldCheck,
  AlertTriangle,
  AlertCircle,
  CheckCircle2,
  Calendar,
  FileText,
  Activity,
  Send,
  XCircle,
  Bell,
  Clock,
  Info,
} from "lucide-react";
import { SendApprovalModal } from "./send-approval-modal";
import { SendReminderApprovalModal } from "./send-reminder-approval-modal";
import { CancelApprovalModal } from "./cancel-approval-modal";
import { canSendReminder, canCancelInvoice } from "@/lib/paypal/status-mapper";

export interface SerializedActivityEvent {
  id: string;
  eventType: string;
  actorType: string;
  actorId: string | null;
  description: string;
  createdAt: string;
  metadata?: Prisma.JsonValue;
}

export interface SerializedLineItem {
  id: string;
  description: string;
  quantity: number;
  unitPriceMinorUnits: number;
  totalMinorUnits: number;
  sortOrder: number;
}

export interface SerializedInvoiceDetail {
  id: string;
  workspaceId: string;
  clientId: string;
  number: string | null;
  materialPayloadHash?: string;
  reminderMaterialPayloadHash?: string;
  cancelMaterialPayloadHash?: string;
  isReminderCooldownActive?: boolean;
  recentReminderCompletedAt?: string | null;
  title: string | null;
  notes?: string | null;
  terms?: string | null;
  currency: string;
  subtotalMinorUnits: number;
  taxRateBasisPoints: number;
  taxMinorUnits: number;
  totalMinorUnits: number;
  invoiceDate: string;
  dueDate: string;
  cashpilotStatus: CashPilotStatus;
  paypalInvoiceId: string | null;
  paypalStatus: string | null;
  lastSyncAt: string | null;
  syncIsStale: boolean;
  isDemoData: boolean;
  aiDraftId: string | null;
  client: {
    id: string;
    name: string;
    email: string;
    company: string | null;
    phone: string | null;
    isDemo: boolean;
  };
  lineItems: SerializedLineItem[];
  activities?: SerializedActivityEvent[];
  workspace?: {
    id: string;
    name: string;
    isDemo: boolean;
  };
}

interface InvoiceDetailViewProps {
  initialInvoice: SerializedInvoiceDetail;
}

interface SyncAlert {
  type: "success" | "warning" | "error" | "info";
  title: string;
  message: string;
  details?: string;
}

export function InvoiceDetailView({ initialInvoice }: InvoiceDetailViewProps) {
  const [invoice, setInvoice] = useState<SerializedInvoiceDetail>(initialInvoice);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncAlert, setSyncAlert] = useState<SyncAlert | null>(null);
  const [isSendModalOpen, setIsSendModalOpen] = useState(false);
  const [isRemindModalOpen, setIsRemindModalOpen] = useState(false);
  const [isCancelModalOpen, setIsCancelModalOpen] = useState(false);

  // Eligible to send only if in DRAFT state and has a PayPal Sandbox draft created
  const canSend = invoice.cashpilotStatus === CashPilotStatus.DRAFT && Boolean(invoice.paypalInvoiceId);

  // Eligible for reminder only if in AWAITING_PAYMENT, DUE_SOON, or OVERDUE and has PayPal invoice ID
  const isReminderStatusEligible = canSendReminder(invoice.cashpilotStatus) && Boolean(invoice.paypalInvoiceId);

  // Cooldown: at most once every 24 hours
  const isWithinReminderCooldown = Boolean(
    invoice.isReminderCooldownActive || invoice.recentReminderCompletedAt
  );

  const canRemind = isReminderStatusEligible && !isWithinReminderCooldown;

  // Eligible for cancellation: sent unpaid invoice with fresh provider state
  const canCancel =
    Boolean(invoice.paypalInvoiceId) &&
    canCancelInvoice(invoice.cashpilotStatus, invoice.paypalStatus) &&
    !invoice.syncIsStale &&
    invoice.cashpilotStatus !== CashPilotStatus.NEEDS_REVIEW;

  const handleCancelSuccess = (cancelResult: {
    operationId: string;
    invoiceId: string;
    paypalInvoiceId: string;
    previousStatus: CashPilotStatus;
    currentStatus: CashPilotStatus;
    previousPaypalStatus: string | null;
    currentPaypalStatus: string;
    cancelledAt: string;
    correlationId?: string;
  }) => {
    setInvoice((prev) => ({
      ...prev,
      cashpilotStatus: cancelResult.currentStatus,
      paypalStatus: cancelResult.currentPaypalStatus,
      syncIsStale: false,
    }));

    setSyncAlert({
      type: "success",
      title: "Invoice Cancelled on PayPal Sandbox",
      message: `Invoice ${invoice.number ?? invoice.id} has been permanently cancelled on PayPal Sandbox.`,
      details:
        "Workflow status updated to CANCELLED. Online payment can no longer be accepted for this invoice. Historical records and audit trail are retained.",
    });

    // Refresh activity list from GET /api/invoices/[id]
    fetch(`/api/invoices/${invoice.id}?workspaceId=${invoice.workspaceId}`)
      .then((res) => res.json())
      .then((json) => {
        if (json.success && json.data.activities) {
          setInvoice((prev) => ({
            ...prev,
            activities: json.data.activities,
          }));
        }
      })
      .catch(() => {});
  };

  const handleSendSuccess = (sendResult: {
    operationId: string;
    invoiceId: string;
    paypalInvoiceId: string;
    paypalStatus: string;
    cashpilotStatus: CashPilotStatus;
    sentAt: string;
    correlationId?: string;
  }) => {
    setInvoice((prev) => ({
      ...prev,
      cashpilotStatus: sendResult.cashpilotStatus,
      paypalStatus: sendResult.paypalStatus,
      syncIsStale: false,
    }));

    setSyncAlert({
      type: "success",
      title: "Invoice Sent via PayPal Sandbox",
      message: `Invoice ${invoice.number ?? invoice.id} has been dispatched to ${invoice.client.email}. PayPal status is now ${sendResult.paypalStatus}.`,
      details:
        "Workflow status updated to Awaiting Payment. (Note: A sent invoice is unpaid; payment will be recorded only when PayPal confirms receipt.)",
    });

    // Refresh activity list from GET /api/invoices/[id]
    fetch(`/api/invoices/${invoice.id}?workspaceId=${invoice.workspaceId}`)
      .then((res) => res.json())
      .then((json) => {
        if (json.success && json.data.activities) {
          setInvoice((prev) => ({
            ...prev,
            activities: json.data.activities,
          }));
        }
      })
      .catch(() => {});
  };

  const handleRemindSuccess = (remindResult: {
    operationId: string;
    invoiceId: string;
    paypalInvoiceId: string;
    recipientEmail: string;
    reminded: boolean;
    remindedAt: string;
    correlationId?: string;
  }) => {
    setInvoice((prev) => ({
      ...prev,
      isReminderCooldownActive: true,
      recentReminderCompletedAt: remindResult.remindedAt,
      lastSyncAt: remindResult.remindedAt,
      syncIsStale: false,
    }));

    setSyncAlert({
      type: "success",
      title: "Payment Reminder Sent via PayPal Sandbox",
      message: `A payment reminder for invoice ${invoice.number ?? invoice.id} has been dispatched to ${remindResult.recipientEmail}.`,
      details: `Invoice status remains ${invoice.cashpilotStatus}. (Note: A reminder is a notification only; it does not alter invoice balance or establish a Paid status.)`,
    });

    // Refresh activity list from GET /api/invoices/[id]
    fetch(`/api/invoices/${invoice.id}?workspaceId=${invoice.workspaceId}`)
      .then((res) => res.json())
      .then((json) => {
        if (json.success && json.data.activities) {
          setInvoice((prev) => ({
            ...prev,
            activities: json.data.activities,
          }));
        }
      })
      .catch(() => {});
  };

  const provenance = getInvoiceProvenance({
    ...invoice,
    aiDraftId: invoice.aiDraftId ?? null,
    invoiceDate: invoice.invoiceDate,
    dueDate: invoice.dueDate,
  });

  const formattedTotal = formatMoney(invoice.totalMinorUnits, invoice.currency);
  const formattedSubtotal = formatMoney(invoice.subtotalMinorUnits, invoice.currency);
  const formattedTax = formatMoney(invoice.taxMinorUnits, invoice.currency);

  // Derive Navi expression & contextual message (strictly in helper card)
  let naviState: NaviState = "idle";
  let naviTitle = "Navi Guidance";
  let naviBody = "Review line items and financial details for this invoice.";

  if (invoice.syncIsStale) {
    naviState = "thinking";
    naviTitle = "Navi — Sync Stale · Attention Required";
    naviBody =
      "The last status refresh with PayPal Sandbox failed or timed out. Previous known status has been preserved. Click 'Sync status' to safely reconcile.";
  } else if (invoice.cashpilotStatus === CashPilotStatus.PAID) {
    naviState = "done";
    naviTitle = "Navi — Payment Confirmed";
    naviBody =
      "Payment has been verified directly by PayPal Sandbox. This invoice is closed and fully settled.";
  } else if (invoice.cashpilotStatus === CashPilotStatus.OVERDUE) {
    naviState = "helping";
    naviTitle = "Navi — Overdue Invoice";
    naviBody =
      "This invoice is past its due date. You can sync status to check if customer payment arrived in PayPal Sandbox.";
  } else if (
    invoice.cashpilotStatus === CashPilotStatus.AWAITING_PAYMENT ||
    invoice.cashpilotStatus === CashPilotStatus.DUE_SOON
  ) {
    naviState = "helping";
    naviTitle = "Navi — Sent & Awaiting Payment";
    naviBody =
      "Invoice was sent via PayPal Sandbox. Status updates automatically when PayPal verifies payment. Sync status anytime to verify live state.";
  } else if (invoice.cashpilotStatus === CashPilotStatus.DRAFT) {
    naviState = invoice.paypalInvoiceId ? "helping" : "idle";
    naviTitle = invoice.paypalInvoiceId ? "Navi — PayPal Draft Created" : "Navi — Local Draft";
    naviBody = invoice.paypalInvoiceId
      ? "A draft invoice exists in PayPal Sandbox. You can verify provider status or review line items before sending."
      : "This invoice is currently saved locally in CashPilot. Review all line items, tax, and recipient details.";
  } else if (invoice.cashpilotStatus === CashPilotStatus.NEEDS_REVIEW) {
    naviState = "thinking";
    naviTitle = "Navi — Status Review Required";
    naviBody =
      "An unrecognised status or provider discrepancy requires human review. Financial truth is preserved without guessing.";
  }

  // Safe status synchronization handler
  const handleSyncStatus = async () => {
    // Prevent duplicate concurrent clicks
    if (isSyncing) return;

    setIsSyncing(true);
    setSyncAlert(null);

    try {
      const res = await fetch(`/api/invoices/${invoice.id}/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-workspace-id": invoice.workspaceId,
        },
      });

      const json = await res.json();

      if (!res.ok || !json.success) {
        const errorCode = json.code || "SYNC_ERROR";
        const errorMessage = json.error || "Failed to sync status with PayPal Sandbox.";

        // Preserve previous known state and mark stale as per financial integrity rules
        setInvoice((prev) => ({
          ...prev,
          syncIsStale: true,
        }));

        if (errorCode === "TIMEOUT" || res.status === 504) {
          setSyncAlert({
            type: "warning",
            title: "PayPal Sandbox Request Timed Out",
            message: "The request timed out. Outcome is unknown; previous known status has been preserved as stale.",
            details: "CashPilot will never guess or mark an invoice Paid on timeout. You can retry status synchronization.",
          });
        } else if (errorCode === "PROVIDER_INVOICE_NOT_FOUND" || res.status === 404) {
          setSyncAlert({
            type: "error",
            title: "Provider Invoice Not Found (404)",
            message: `PayPal invoice ${invoice.paypalInvoiceId ?? ""} was not found on PayPal Sandbox.`,
            details: "Recorded as discrepancy without recreating. Status marked for review.",
          });
        } else if (res.status === 403) {
          setSyncAlert({
            type: "error",
            title: "Access Denied (403)",
            message: "Unauthorized cross-workspace access attempt rejected by server guard.",
          });
        } else {
          setSyncAlert({
            type: "error",
            title: "Status Synchronization Failed",
            message: errorMessage,
            details: "Last known valid provider status preserved without guessing.",
          });
        }
        return;
      }

      // Success response from sync endpoint
      const syncData = json.data;

      setInvoice((prev) => ({
        ...prev,
        cashpilotStatus: syncData.currentCashpilotStatus ?? prev.cashpilotStatus,
        paypalStatus: syncData.currentPaypalStatus ?? prev.paypalStatus,
        lastSyncAt: syncData.lastSyncAt ?? new Date().toISOString(),
        syncIsStale: false,
      }));

      if (!syncData.hasPaypalInvoice) {
        setSyncAlert({
          type: "info",
          title: "Local CashPilot Draft",
          message: "This invoice is a local draft and has not been created on PayPal Sandbox yet.",
          details: "Create a PayPal draft first to enable status synchronization.",
        });
      } else if (syncData.statusChanged) {
        setSyncAlert({
          type: "success",
          title: "Status Reconciled with PayPal Sandbox",
          message: `Status updated: ${syncData.previousCashpilotStatus} → ${syncData.currentCashpilotStatus}. Provider status: ${syncData.currentPaypalStatus}.`,
          details: "Verified evidence retrieved from PayPal Sandbox Invoicing API.",
        });
      } else {
        setSyncAlert({
          type: "success",
          title: "Status Verified Up-to-Date",
          message: `PayPal Sandbox reports status: ${syncData.currentPaypalStatus ?? "DRAFT"}. No changes detected.`,
          details: `Reconciled at ${new Date(syncData.lastSyncAt || Date.now()).toLocaleTimeString()}.`,
        });
      }

      // Refresh activity list from GET /api/invoices/[id]
      try {
        const refreshRes = await fetch(`/api/invoices/${invoice.id}?workspaceId=${invoice.workspaceId}`);
        if (refreshRes.ok) {
          const freshData = await refreshRes.json();
          if (freshData.success && freshData.data.activities) {
            setInvoice((prev) => ({
              ...prev,
              activities: freshData.data.activities,
            }));
          }
        }
      } catch {
        // Non-fatal if activity refresh fails
      }
    } catch (err) {
      setInvoice((prev) => ({
        ...prev,
        syncIsStale: true,
      }));
      setSyncAlert({
        type: "error",
        title: "Network Connection Error",
        message: err instanceof Error ? err.message : "Unable to reach the synchronization server.",
        details: "Last known valid state preserved.",
      });
    } finally {
      setIsSyncing(false);
    }
  };

  // Helper for activity event icons
  const getActivityIcon = (eventType: string) => {
    switch (eventType) {
      case "STATUS_SYNCED":
      case "STATUS_SYNC_FAILED":
        return <RefreshCw className="w-3.5 h-3.5 text-[#0C7C61]" />;
      case "APPROVAL_APPROVED":
      case "APPROVAL_CREATED":
        return <ShieldCheck className="w-3.5 h-3.5 text-[#0C7C61]" />;
      case "INVOICE_SENT":
        return <Send className="w-3.5 h-3.5 text-[#5B3FD0]" />;
      case "INVOICE_CANCELLED":
        return <XCircle className="w-3.5 h-3.5 text-[#B4440B]" />;
      case "PAYMENT_REMINDER_SENT":
        return <Bell className="w-3.5 h-3.5 text-[#7A5600]" />;
      case "INVOICE_CREATED":
      case "DRAFT_CREATED":
        return <FileText className="w-3.5 h-3.5 text-[#5E718D]" />;
      default:
        return <Activity className="w-3.5 h-3.5 text-[#5E718D]" />;
    }
  };

  return (
    <div className="space-y-6" data-testid="invoice-detail-view">
      {/* Navigation Breadcrumb */}
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-xs text-[#5E718D]">
        <Link
          href="/"
          className="hover:text-[#12263F] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#0C7C61] rounded-sm px-1 py-0.5 transition-colors"
        >
          Dashboard
        </Link>
        <span aria-hidden="true">/</span>
        <Link
          href="/collections"
          className="hover:text-[#12263F] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#0C7C61] rounded-sm px-1 py-0.5 transition-colors"
        >
          Collections
        </Link>
        <span aria-hidden="true">/</span>
        <span className="font-mono text-[#12263F] font-semibold">
          {invoice.number ?? invoice.id.slice(0, 10)}
        </span>
      </nav>

      {/* Invoice Title & Actions Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-[#E3E8EF]">
        <div>
          <div className="flex flex-wrap items-center gap-2.5 mb-1.5">
            <h1 className="font-headline font-bold text-2xl sm:text-3xl text-[#12263F]">
              {invoice.number ?? "Invoice"}
            </h1>
            <StatusBadge status={invoice.cashpilotStatus} />
            <span
              className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium border ${provenance.badgeClass}`}
            >
              <span className="font-mono text-[10px]" aria-hidden="true">
                {provenance.symbol}
              </span>
              <span>{provenance.label}</span>
            </span>
          </div>
          {invoice.title && (
            <p className="text-sm text-[#5E718D]">{invoice.title}</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {/* Send Invoice Action Button (Only if eligible: DRAFT status & PayPal draft exists) */}
          {canSend && (
            <button
              type="button"
              onClick={() => setIsSendModalOpen(true)}
              aria-label="Approve and send invoice via PayPal Sandbox"
              className="inline-flex items-center justify-center gap-2 px-3.5 py-2 min-h-[44px] rounded-xl bg-[#B4440B] hover:bg-[#933708] text-white text-xs font-semibold shadow-xs active:scale-[0.98] transition-all focus-visible:ring-2 focus-visible:ring-[#B4440B] focus-visible:outline-hidden"
            >
              <Send className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>Send invoice</span>
            </button>
          )}

          {/* Send Reminder Action Button (Only if eligible: AWAITING_PAYMENT, DUE_SOON, OVERDUE) */}
          {isReminderStatusEligible &&
            (canRemind ? (
              <button
                type="button"
                onClick={() => setIsRemindModalOpen(true)}
                aria-label="Approve and send payment reminder via PayPal Sandbox"
                className="inline-flex items-center justify-center gap-2 px-3.5 py-2 min-h-[44px] rounded-xl bg-[#0F6CBD] hover:bg-[#0C5494] text-white text-xs font-semibold shadow-xs active:scale-[0.98] transition-all focus-visible:ring-2 focus-visible:ring-[#0F6CBD] focus-visible:outline-hidden"
              >
                <Bell className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>Send reminder</span>
              </button>
            ) : (
              <button
                type="button"
                disabled
                title={`Reminder cooldown active: A reminder was sent within the last 24 hours (${new Date(invoice.recentReminderCompletedAt!).toLocaleTimeString()}).`}
                aria-label="Send reminder disabled: 24-hour cooldown active"
                className="inline-flex items-center justify-center gap-2 px-3.5 py-2 min-h-[44px] rounded-xl border border-[#E3E8EF] bg-[#F6F5F1] text-[#8C9BAE] text-xs font-semibold cursor-not-allowed"
              >
                <Bell className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>Reminder in cooldown</span>
              </button>
            ))}

          {/* Cancel Invoice Action Button (Only if eligible: sent unpaid invoice & fresh provider status) */}
          {canCancel && (
            <button
              type="button"
              onClick={() => setIsCancelModalOpen(true)}
              aria-label="Approve and cancel invoice on PayPal Sandbox"
              className="inline-flex items-center justify-center gap-2 px-3.5 py-2 min-h-[44px] rounded-xl border border-[#FDA29B] bg-white hover:bg-[#FEF3F2] text-[#B42318] text-xs font-semibold shadow-xs active:scale-[0.98] transition-all focus-visible:ring-2 focus-visible:ring-[#D92D20] focus-visible:outline-hidden"
            >
              <XCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>Cancel invoice</span>
            </button>
          )}

          {/* Safe Status Sync Action Button */}
          <button
            type="button"
            onClick={handleSyncStatus}
            disabled={isSyncing}
            aria-label="Synchronize status with PayPal Sandbox"
            aria-busy={isSyncing}
            className="inline-flex items-center justify-center gap-2 px-3.5 py-2 min-h-[44px] rounded-xl border border-[#E3E8EF] bg-white hover:bg-[#F6F5F1] text-xs font-semibold text-[#12263F] shadow-xs active:scale-[0.98] transition-all disabled:opacity-60 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-[#0C7C61] focus-visible:outline-hidden"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 text-[#0C7C61] shrink-0 ${
                isSyncing ? "animate-spin" : ""
              }`}
              aria-hidden="true"
            />
            <span>{isSyncing ? "Syncing with PayPal..." : "Sync status"}</span>
          </button>

          <Link
            href="/collections"
            className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 min-h-[44px] rounded-xl border border-[#E3E8EF] bg-white hover:bg-[#F6F5F1] text-xs font-semibold text-[#12263F] shadow-xs active:scale-[0.98] transition-all focus-visible:ring-2 focus-visible:ring-[#0C7C61] focus-visible:outline-hidden"
          >
            <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Back to board</span>
          </Link>
        </div>
      </div>

      {/* Sync Feedback Alert Banner */}
      {syncAlert && (
        <div
          role="status"
          aria-live="polite"
          className={`p-4 rounded-xl border text-xs flex items-start gap-3 transition-all ${
            syncAlert.type === "success"
              ? "bg-[#E8F5F1] border-[#A3D9CC] text-[#0C7C61]"
              : syncAlert.type === "warning"
              ? "bg-[#FEF9E7] border-[#F3E0A2] text-[#7A5600]"
              : syncAlert.type === "info"
              ? "bg-[#F0EEFF] border-[#CDC4FF] text-[#5B3FD0]"
              : "bg-[#FEF3F2] border-[#FECDCA] text-[#B42318]"
          }`}
        >
          {syncAlert.type === "success" ? (
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
          ) : syncAlert.type === "warning" ? (
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          ) : syncAlert.type === "info" ? (
            <Info className="w-4 h-4 shrink-0 mt-0.5" />
          ) : (
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          )}
          <div className="space-y-1 flex-1">
            <p className="font-semibold">{syncAlert.title}</p>
            <p className="text-opacity-90">{syncAlert.message}</p>
            {syncAlert.details && (
              <p className="text-[11px] opacity-80">{syncAlert.details}</p>
            )}
          </div>
        </div>
      )}

      {/* Stale State Banner (if not already covered by recent sync alert) */}
      {!syncAlert && invoice.syncIsStale && (
        <div
          role="status"
          className="p-4 rounded-xl bg-[#FEF9E7] border border-[#F3E0A2] text-[#7A5600] text-xs flex items-start gap-3"
        >
          <Clock className="w-4 h-4 shrink-0 mt-0.5 text-[#7A5600]" />
          <div className="space-y-0.5">
            <p className="font-semibold">Notice: Status May Be Stale</p>
            <p className="text-[#5E718D]">
              The last synchronization with PayPal Sandbox was unsuccessful. CashPilot preserves the last known valid status without guessing. Click <strong>Sync status</strong> to reconcile with PayPal.
            </p>
          </div>
        </div>
      )}

      {/* Contextual Navi Guidance Callout (Strict placement rules respected: helper callout only) */}
      <section
        aria-label="Navi Guidance"
        className="p-4 sm:p-5 rounded-2xl bg-white border border-[#E3E8EF] shadow-xs flex flex-col sm:flex-row items-start gap-4"
      >
        <NaviAvatar state={naviState} size={42} showStatusIndicator={true} />
        <div className="space-y-1 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold text-xs tracking-wide uppercase text-[#5B3FD0]">
              {naviTitle}
            </h2>
            {invoice.isDemoData && (
              <span className="text-[10px] font-medium px-2 py-0.5 rounded-md bg-[#F4F6F8] text-[#5E718D] border border-[#E3E8EF]">
                Sample Data
              </span>
            )}
          </div>
          <p className="text-xs text-[#5E718D] leading-relaxed">{naviBody}</p>
        </div>
      </section>

      {/* Details Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Left Column: Metadata & Provider State (1 col) */}
        <div className="space-y-6">
          {/* Client & Recipient Details */}
          <div className="rounded-2xl bg-white border border-[#E3E8EF] p-5 shadow-xs space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-xs tracking-wider uppercase text-[#5E718D]">
                Client & Recipient
              </h3>
              {invoice.client.isDemo && (
                <span className="text-[10px] text-[#5E718D] bg-[#F6F5F1] px-1.5 py-0.5 rounded">
                  Demo Client
                </span>
              )}
            </div>

            <div className="space-y-2 text-xs">
              <div className="font-semibold text-sm text-[#12263F]">
                {invoice.client.name}
              </div>

              <div className="flex items-center gap-2 text-[#5E718D]">
                <Mail className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span className="font-mono truncate">{invoice.client.email}</span>
              </div>

              {invoice.client.company && (
                <div className="flex items-center gap-2 text-[#5E718D]">
                  <Building className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span>{invoice.client.company}</span>
                </div>
              )}

              {invoice.client.phone && (
                <div className="flex items-center gap-2 text-[#5E718D]">
                  <Phone className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span className="font-mono">{invoice.client.phone}</span>
                </div>
              )}
            </div>
          </div>

          {/* Dates & Terms */}
          <div className="rounded-2xl bg-white border border-[#E3E8EF] p-5 shadow-xs space-y-3 text-xs">
            <h3 className="font-semibold text-xs tracking-wider uppercase text-[#5E718D]">
              Invoice Dates & Terms
            </h3>

            <div className="flex justify-between py-1 border-b border-[#EEF2F6]">
              <span className="text-[#5E718D] flex items-center gap-1.5">
                <Calendar className="w-3 h-3 text-[#5E718D]" aria-hidden="true" />
                Issued Date:
              </span>
              <span className="font-mono font-medium">
                {new Date(invoice.invoiceDate).toLocaleDateString()}
              </span>
            </div>

            <div className="flex justify-between py-1 border-b border-[#EEF2F6]">
              <span className="text-[#5E718D] flex items-center gap-1.5">
                <Calendar className="w-3 h-3 text-[#5E718D]" aria-hidden="true" />
                Due Date:
              </span>
              <span className="font-mono font-medium">
                {new Date(invoice.dueDate).toLocaleDateString()}
              </span>
            </div>

            <div className="flex justify-between py-1">
              <span className="text-[#5E718D]">Terms:</span>
              <span className="font-medium text-[#12263F]">
                {invoice.terms || "Standard (Due on receipt)"}
              </span>
            </div>

            {invoice.notes && (
              <div className="pt-2 border-t border-[#EEF2F6]">
                <span className="text-[#5E718D] block mb-1">Notes:</span>
                <p className="text-[11px] text-[#12263F] bg-[#F6F5F1] p-2 rounded-lg">
                  {invoice.notes}
                </p>
              </div>
            )}
          </div>

          {/* PayPal Sandbox Provider State */}
          <div className="rounded-2xl bg-white border border-[#E3E8EF] p-5 shadow-xs space-y-3 text-xs">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-xs tracking-wider uppercase text-[#5E718D]">
                PayPal Sandbox State
              </h3>
              <span className="text-[10px] font-mono text-[#0C7C61] bg-[#E8F5F1] px-1.5 py-0.5 rounded">
                Sandbox
              </span>
            </div>

            <div className="flex justify-between py-1 border-b border-[#EEF2F6]">
              <span className="text-[#5E718D]">Provider ID:</span>
              <span className="font-mono text-[11px] font-semibold text-[#12263F] truncate max-w-[170px]">
                {invoice.paypalInvoiceId ?? "Not created on PayPal"}
              </span>
            </div>

            <div className="flex justify-between py-1 border-b border-[#EEF2F6]">
              <span className="text-[#5E718D]">Provider Status:</span>
              <span className="font-mono font-semibold text-[#12263F]">
                {invoice.paypalStatus ?? "None"}
              </span>
            </div>

            <div className="flex justify-between py-1 border-b border-[#EEF2F6]">
              <span className="text-[#5E718D]">CashPilot State:</span>
              <span className="font-semibold text-[#12263F]">
                {invoice.cashpilotStatus}
              </span>
            </div>

            <div className="flex justify-between py-1 border-b border-[#EEF2F6]">
              <span className="text-[#5E718D]">Last Synced:</span>
              <span className="font-mono text-[11px] text-[#5E718D]">
                {invoice.lastSyncAt
                  ? new Date(invoice.lastSyncAt).toLocaleString()
                  : "Never synced"}
              </span>
            </div>

            <div className="flex justify-between py-1">
              <span className="text-[#5E718D]">Sync Freshness:</span>
              <span
                className={`font-semibold text-[11px] ${
                  invoice.syncIsStale
                    ? "text-[#B4440B]"
                    : invoice.lastSyncAt
                    ? "text-[#0C7C61]"
                    : "text-[#5E718D]"
                }`}
              >
                {invoice.syncIsStale
                  ? "Sync Stale (Failed/Timed out)"
                  : invoice.lastSyncAt
                  ? "Synchronized"
                  : "Not yet synced"}
              </span>
            </div>

            <p className="text-[10px] text-[#5E718D] italic pt-1 leading-tight">
              Provider status and workflow status remain strictly separate. Verified payment evidence is required to mark Paid.
            </p>
          </div>
        </div>

        {/* Right Column: Line Items & Totals & Audit Trail (2 cols) */}
        <div className="md:col-span-2 space-y-6">
          {/* Line Items Table Card */}
          <div className="rounded-2xl bg-white border border-[#E3E8EF] shadow-xs overflow-hidden">
            <div className="p-4 sm:p-5 border-b border-[#E3E8EF] flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-sm text-[#12263F]">
                  Line Items & Financial Calculation
                </h3>
                <p className="text-xs text-[#5E718D] mt-0.5">
                  Authoritative line items and totals calculated server-side
                </p>
              </div>
              <span className="font-mono text-xs px-2 py-0.5 rounded bg-[#F4F6F8] text-[#5E718D] border border-[#E3E8EF]">
                {invoice.currency}
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead className="bg-[#F6F5F1] text-[11px] font-semibold text-[#5E718D] uppercase tracking-wider border-b border-[#E3E8EF]">
                  <tr>
                    <th className="py-2.5 px-4 sm:px-6">Description</th>
                    <th className="py-2.5 px-4 text-center">Qty</th>
                    <th className="py-2.5 px-4 text-right">Unit Price</th>
                    <th className="py-2.5 px-4 sm:px-6 text-right">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#EEF2F6]">
                  {invoice.lineItems.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-8 text-center text-xs text-[#5E718D]">
                        No line items recorded for this invoice.
                      </td>
                    </tr>
                  ) : (
                    invoice.lineItems.map((item) => (
                      <tr key={item.id} className="hover:bg-[#F6F5F1]/30 transition-colors">
                        <td className="py-3 px-4 sm:px-6 font-medium text-[#12263F]">
                          {item.description}
                        </td>
                        <td className="py-3 px-4 text-center font-mono tabular-nums text-[#5E718D]">
                          {item.quantity}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums text-[#5E718D]">
                          {formatMoney(item.unitPriceMinorUnits, invoice.currency)}
                        </td>
                        <td className="py-3 px-4 sm:px-6 text-right font-mono font-semibold tabular-nums text-[#12263F]">
                          {formatMoney(item.totalMinorUnits, invoice.currency)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Authoritative Financial Totals Summary */}
            <div className="p-4 sm:p-6 bg-[#F6F5F1]/40 border-t border-[#E3E8EF] flex justify-end">
              <div className="w-full max-w-xs space-y-2 text-xs">
                <div className="flex justify-between text-[#5E718D]">
                  <span>Subtotal:</span>
                  <span className="font-mono tabular-nums">{formattedSubtotal}</span>
                </div>

                {invoice.taxMinorUnits > 0 && (
                  <div className="flex justify-between text-[#5E718D]">
                    <span>Tax ({(invoice.taxRateBasisPoints / 100).toFixed(1)}%):</span>
                    <span className="font-mono tabular-nums">{formattedTax}</span>
                  </div>
                )}

                <div className="flex justify-between pt-2 border-t border-[#E3E8EF] font-bold text-sm text-[#12263F]">
                  <span>Grand Total:</span>
                  <span className="font-mono tabular-nums text-base text-[#0C7C61]">
                    {formattedTotal}
                  </span>
                </div>
                <p className="text-[10px] text-[#5E718D] text-right italic pt-1">
                  Authoritative totals calculated server-side, never by AI or floating-point arithmetic.
                </p>
              </div>
            </div>
          </div>

          {/* Audit Activity History Card */}
          <div className="rounded-2xl bg-white border border-[#E3E8EF] p-5 shadow-xs space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-xs tracking-wider uppercase text-[#5E718D]">
                Audit Activity History
              </h3>
              <span className="text-[10px] text-[#5E718D]">
                {invoice.activities?.length ?? 0} events recorded
              </span>
            </div>

            {!invoice.activities || invoice.activities.length === 0 ? (
              <p className="text-xs text-[#5E718D] italic py-3">
                No activity events recorded for this invoice yet.
              </p>
            ) : (
              <div className="divide-y divide-[#EEF2F6]">
                {invoice.activities.map((act) => (
                  <div key={act.id} className="py-2.5 flex items-start gap-2.5 text-xs">
                    <div className="p-1 rounded-md bg-[#F4F6F8] shrink-0 mt-0.5">
                      {getActivityIcon(act.eventType)}
                    </div>
                    <div className="flex-1">
                      <p className="text-[#12263F] font-medium leading-snug">
                        {act.description}
                      </p>
                      <p className="text-[11px] text-[#5E718D] mt-0.5">
                        {new Date(act.createdAt).toLocaleString()} ·{" "}
                        <span className="font-mono uppercase text-[10px]">
                          {act.actorType}
                        </span>
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Human Approval Gate Modal for SEND_INVOICE */}
      <SendApprovalModal
        isOpen={isSendModalOpen}
        onClose={() => setIsSendModalOpen(false)}
        invoice={invoice}
        materialPayloadHash={invoice.materialPayloadHash ?? ""}
        onSendSuccess={handleSendSuccess}
      />

      {/* Human Approval Gate Modal for SEND_REMINDER */}
      <SendReminderApprovalModal
        isOpen={isRemindModalOpen}
        onClose={() => setIsRemindModalOpen(false)}
        invoice={invoice}
        materialPayloadHash={invoice.reminderMaterialPayloadHash ?? ""}
        onRemindSuccess={handleRemindSuccess}
      />

      {/* Human Approval Gate Modal for CANCEL_INVOICE */}
      <CancelApprovalModal
        isOpen={isCancelModalOpen}
        onClose={() => setIsCancelModalOpen(false)}
        invoice={invoice}
        materialPayloadHash={invoice.cancelMaterialPayloadHash ?? ""}
        onCancelSuccess={handleCancelSuccess}
      />

      {/* MVP Limitations Notice */}
      <footer className="pt-4 border-t border-[#E3E8EF] text-[11px] text-[#5E718D] flex flex-col sm:flex-row items-center justify-between gap-2">
        <p>
          CashPilot AI Receivables Workspace · PayPal Sandbox Environment
        </p>
        <p className="text-right">
          MVP session authentication scoped to workspace. Consequential writes require explicit human approval.
        </p>
      </footer>
    </div>
  );
}
