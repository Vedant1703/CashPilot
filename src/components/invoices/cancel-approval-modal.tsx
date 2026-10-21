"use client";

import React, { useState, useEffect } from "react";
import { formatMoney } from "@/lib/money";
import { Lock, AlertTriangle, XCircle, X, ShieldAlert, RefreshCw } from "lucide-react";
import { SerializedInvoiceDetail } from "./invoice-detail-view";
import { CashPilotStatus } from "@prisma/client";

interface CancelApprovalModalProps {
  invoice: SerializedInvoiceDetail;
  materialPayloadHash: string;
  isOpen: boolean;
  onClose: () => void;
  onCancelSuccess: (cancelResult: {
    operationId: string;
    invoiceId: string;
    paypalInvoiceId: string;
    previousStatus: CashPilotStatus;
    currentStatus: CashPilotStatus;
    previousPaypalStatus: string | null;
    currentPaypalStatus: string;
    cancelledAt: string;
    correlationId?: string;
  }) => void;
}

export function CancelApprovalModal({
  invoice,
  materialPayloadHash,
  isOpen,
  onClose,
  onCancelSuccess,
}: CancelApprovalModalProps) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStep, setProcessingStep] = useState<"idle" | "approving" | "cancelling">("idle");
  const [error, setError] = useState<string | null>(null);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isProcessing) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, isProcessing, onClose]);

  if (!isOpen) return null;

  const formattedTotal = formatMoney(invoice.totalMinorUnits, invoice.currency);
  const invoiceIdentifier = invoice.number ?? invoice.id.slice(0, 10);

  const handleApproveAndCancel = async () => {
    // Prevent duplicate concurrent submissions
    if (isProcessing) return;

    setIsProcessing(true);
    setProcessingStep("approving");
    setError(null);

    try {
      // Step 1: Submit Human Approval (CANCEL_INVOICE) bound to exact material hash
      const approveRes = await fetch(`/api/invoices/${invoice.id}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-workspace-id": invoice.workspaceId,
        },
        body: JSON.stringify({
          actionType: "CANCEL_INVOICE",
          reviewedPayloadHash: materialPayloadHash,
        }),
      });

      const approveJson = await approveRes.json();

      if (!approveRes.ok || !approveJson.success) {
        if (approveRes.status === 409 || approveJson.code === "STALE_PAYLOAD_HASH") {
          setError(
            "Approval cancelled: The invoice material details have changed since review. Please refresh the invoice and review again."
          );
        } else if (approveJson.code === "PROVIDER_STATE_AMBIGUOUS") {
          setError(
            "Invoice provider state is ambiguous or stale. Please synchronize status with PayPal before cancelling."
          );
        } else {
          setError(approveJson.error || "Approval was rejected by the server.");
        }
        setIsProcessing(false);
        setProcessingStep("idle");
        return;
      }

      const approvalId = approveJson.data.approvalId;

      // Step 2: Execute cancellation operation with confirmed approval ID
      setProcessingStep("cancelling");
      const cancelRes = await fetch(`/api/invoices/${invoice.id}/cancel`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-workspace-id": invoice.workspaceId,
        },
        body: JSON.stringify({ approvalId }),
      });

      const cancelJson = await cancelRes.json();

      if (!cancelRes.ok || !cancelJson.success) {
        if (cancelRes.status === 504 || cancelJson.code === "OPERATION_UNKNOWN_OUTCOME") {
          setError(
            "PayPal Sandbox request timed out. Outcome is unknown; no blind retry will be made. Please click 'Sync status' to reconcile before retrying."
          );
        } else if (cancelRes.status === 409 || cancelJson.code === "PENDING_UNKNOWN_OPERATION") {
          setError(
            cancelJson.error ||
              "A conflicting operation or stale approval was detected. Please synchronize status before retrying."
          );
        } else {
          setError(cancelJson.error || "Failed to cancel invoice through PayPal Sandbox.");
        }
        setIsProcessing(false);
        setProcessingStep("idle");
        return;
      }

      // Step 3: Success!
      onCancelSuccess(cancelJson.data);
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Network error during approval and cancellation."
      );
    } finally {
      setIsProcessing(false);
      setProcessingStep("idle");
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cancel-approval-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs animate-in fade-in duration-150 overflow-y-auto"
    >
      <div className="relative w-full max-w-xl my-8 rounded-2xl bg-white border-2 border-[#D92D20] shadow-2xl p-6 sm:p-8 space-y-6 text-[#12263F] animate-in zoom-in-95 duration-150">
        {/* Close Button */}
        <button
          type="button"
          onClick={onClose}
          disabled={isProcessing}
          aria-label="Close cancellation modal"
          className="absolute top-5 right-5 p-2 rounded-xl text-[#5E718D] hover:text-[#12263F] hover:bg-[#F6F5F1] transition-colors disabled:opacity-50 min-h-[44px] min-w-[44px] flex items-center justify-center focus-visible:ring-2 focus-visible:ring-[#D92D20] focus-visible:outline-hidden"
        >
          <X className="w-5 h-5" aria-hidden="true" />
        </button>

        {/* Header with Warning Icon & Consequential Destructive Badge */}
        <div className="flex items-start gap-3.5 pr-8">
          <div className="p-3 rounded-xl bg-[#FEF3F2] text-[#D92D20] border border-[#FECDCA] shrink-0">
            <XCircle className="w-6 h-6 stroke-[2.5]" aria-hidden="true" />
          </div>

          <div className="space-y-1">
            <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-mono font-semibold uppercase tracking-wider text-[#B42318] bg-[#FEF3F2] border border-[#FECDCA]">
              <ShieldAlert className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Human Approval Gate · Irreversible Action</span>
            </div>
            <h2
              id="cancel-approval-title"
              className="font-headline font-bold text-xl sm:text-2xl text-[#12263F]"
            >
              Approve Invoice Cancellation
            </h2>
            <p className="text-xs text-[#5E718D] leading-relaxed">
              This action officially cancels the invoice on PayPal Sandbox. The recipient will no longer be able to view or pay this invoice online.
            </p>
          </div>
        </div>

        {/* Error Notice */}
        {error && (
          <div
            role="alert"
            className="p-4 rounded-xl bg-[#FEF3F2] border border-[#FECDCA] text-[#B42318] text-xs flex items-start gap-2.5 animate-in fade-in"
          >
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            <div className="space-y-0.5 flex-1">
              <p className="font-semibold">Unable to complete cancellation</p>
              <p>{error}</p>
            </div>
          </div>
        )}

        {/* Material Summary Review Card */}
        <div className="rounded-xl bg-[#F6F5F1]/80 border border-[#E3E8EF] p-4 text-xs space-y-2.5">
          <h3 className="font-semibold text-[11px] uppercase tracking-wider text-[#5E718D]">
            Material Invoice Summary
          </h3>

          <div className="flex justify-between py-1 border-b border-[#EEF2F6]">
            <span className="text-[#5E718D]">Invoice Identifier:</span>
            <span className="font-mono font-semibold text-[#12263F]">
              {invoiceIdentifier}
            </span>
          </div>

          <div className="flex justify-between py-1 border-b border-[#EEF2F6]">
            <span className="text-[#5E718D]">Recipient:</span>
            <span className="font-medium text-[#12263F] truncate max-w-[240px]">
              {invoice.client.name} &lt;{invoice.client.email}&gt;
            </span>
          </div>

          <div className="flex justify-between py-1 border-b border-[#EEF2F6]">
            <span className="text-[#5E718D]">Current Status:</span>
            <span className="font-mono font-semibold text-[#B4440B]">
              {invoice.cashpilotStatus} (PayPal: {invoice.paypalStatus ?? "UNKNOWN"})
            </span>
          </div>

          <div className="flex justify-between py-1 border-b border-[#EEF2F6]">
            <span className="text-[#5E718D]">PayPal Invoice ID:</span>
            <span className="font-mono text-[11px] font-semibold text-[#12263F]">
              {invoice.paypalInvoiceId ?? "None"}
            </span>
          </div>

          <div className="flex justify-between py-1 border-b border-[#EEF2F6] font-semibold text-[#12263F]">
            <span>Amount to be Voided:</span>
            <span className="font-mono tabular-nums text-sm text-[#D92D20]">
              {formattedTotal}
            </span>
          </div>
        </div>

        {/* Consequence Warning Notice */}
        <div className="p-3.5 rounded-xl bg-[#FEF3F2] border border-[#FECDCA] text-[11px] text-[#B42318] space-y-1">
          <div className="flex items-center gap-1.5 font-semibold">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>Cancellation Consequences</span>
          </div>
          <p className="text-[11px] text-[#912018] leading-relaxed">
            PayPal Sandbox will immediately void this invoice. Once cancelled, payment cannot be recorded against this invoice. CashPilot audit history, line items, and invoice records are permanently retained for accounting and compliance.
          </p>
        </div>

        {/* Cryptographic Hash Binding Callout */}
        <div className="p-3.5 rounded-xl bg-[#F6F5F1] border border-[#E3E8EF] text-[11px] text-[#5E718D] space-y-1">
          <div className="flex items-center gap-1.5 font-semibold text-[#12263F]">
            <Lock className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>Cryptographic Material Hash Lock</span>
          </div>
          <p className="text-[10px] text-[#5E718D] leading-relaxed">
            Cancellation authorization locks this action to the exact invoice state via SHA-256. If material invoice data changes before execution, approval is automatically invalidated.
          </p>
          <div className="font-mono text-[10px] bg-white p-2 rounded border border-[#E3E8EF] text-[#12263F] break-all select-all font-semibold">
            {materialPayloadHash}
          </div>
        </div>

        {/* Financial Invariant Reminder */}
        <p className="text-[10px] text-[#5E718D] italic leading-tight">
          Financial Truth: Cancellation transitions the invoice to CANCELLED. It can never be marked as Paid, and local database records are never deleted.
        </p>

        {/* Action Controls */}
        <div className="flex flex-col-reverse sm:flex-row items-center justify-end gap-3 pt-2 border-t border-[#E3E8EF]">
          <button
            type="button"
            onClick={onClose}
            disabled={isProcessing}
            className="w-full sm:w-auto px-4 py-2.5 min-h-[44px] rounded-xl border border-[#E3E8EF] text-xs font-semibold text-[#12263F] hover:bg-[#F6F5F1] transition-colors disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-[#D92D20] focus-visible:outline-hidden"
          >
            Keep invoice active
          </button>

          <button
            type="button"
            onClick={handleApproveAndCancel}
            disabled={isProcessing}
            aria-busy={isProcessing}
            className="w-full sm:w-auto px-5 py-2.5 min-h-[44px] rounded-xl bg-[#D92D20] hover:bg-[#B42318] active:scale-[0.98] text-white text-xs font-semibold shadow-xs transition-all flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-[#D92D20] focus-visible:outline-hidden"
          >
            {isProcessing ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin shrink-0" aria-hidden="true" />
                <span>
                  {processingStep === "approving"
                    ? "Validating approval..."
                    : "Cancelling on PayPal Sandbox..."}
                </span>
              </>
            ) : (
              <>
                <XCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>Approve and cancel on PayPal</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
