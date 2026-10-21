"use client";

import React, { useState, useEffect } from "react";
import { formatMoney } from "@/lib/money";
import { Lock, AlertTriangle, Bell, X, ShieldCheck, RefreshCw } from "lucide-react";
import { SerializedInvoiceDetail } from "./invoice-detail-view";

interface SendReminderApprovalModalProps {
  invoice: SerializedInvoiceDetail;
  materialPayloadHash: string;
  isOpen: boolean;
  onClose: () => void;
  onRemindSuccess: (remindResult: {
    operationId: string;
    invoiceId: string;
    paypalInvoiceId: string;
    recipientEmail: string;
    reminded: boolean;
    remindedAt: string;
    correlationId?: string;
  }) => void;
}

export function SendReminderApprovalModal({
  invoice,
  materialPayloadHash,
  isOpen,
  onClose,
  onRemindSuccess,
}: SendReminderApprovalModalProps) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStep, setProcessingStep] = useState<"idle" | "approving" | "reminding">("idle");
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
  const defaultSubject = `Payment Reminder: Invoice ${invoiceIdentifier}`;
  const defaultNote = `Friendly reminder that payment of ${formattedTotal} for invoice ${invoiceIdentifier} is outstanding.`;

  const handleApproveAndRemind = async () => {
    // Prevent duplicate concurrent submissions
    if (isProcessing) return;

    setIsProcessing(true);
    setProcessingStep("approving");
    setError(null);

    try {
      // Step 1: Submit Human Approval (SEND_REMINDER) bound to exact material hash
      const approveRes = await fetch(`/api/invoices/${invoice.id}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-workspace-id": invoice.workspaceId,
        },
        body: JSON.stringify({
          actionType: "SEND_REMINDER",
          reviewedPayloadHash: materialPayloadHash,
        }),
      });

      const approveJson = await approveRes.json();

      if (!approveRes.ok || !approveJson.success) {
        if (approveRes.status === 409 || approveJson.code === "STALE_PAYLOAD_HASH") {
          setError(
            "Approval cancelled: The invoice material details have changed since review. Please refresh the invoice and review again."
          );
        } else {
          setError(approveJson.error || "Approval was rejected by the server.");
        }
        setIsProcessing(false);
        setProcessingStep("idle");
        return;
      }

      const approvalId = approveJson.data.approvalId;

      // Step 2: Execute reminder operation with confirmed approval ID
      setProcessingStep("reminding");
      const remindRes = await fetch(`/api/invoices/${invoice.id}/remind`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-workspace-id": invoice.workspaceId,
        },
        body: JSON.stringify({ approvalId }),
      });

      const remindJson = await remindRes.json();

      if (!remindRes.ok || !remindJson.success) {
        if (remindRes.status === 429 || remindJson.code === "REMINDER_RATE_LIMITED") {
          setError(
            "Reminder rate limit active: A reminder was already sent within the last 24 hours. Reminders are limited to once per 24 hours to prevent spamming the customer."
          );
        } else if (remindRes.status === 504 || remindJson.code === "OPERATION_UNKNOWN_OUTCOME") {
          setError(
            "PayPal Sandbox request timed out. Outcome is unknown; no blind retry will be made. Please click 'Sync status' to reconcile before retrying."
          );
        } else if (remindRes.status === 409) {
          setError(
            remindJson.error ||
              "A conflicting operation or stale approval was detected. Please refresh."
          );
        } else {
          setError(remindJson.error || "Failed to send reminder through PayPal Sandbox.");
        }
        setIsProcessing(false);
        setProcessingStep("idle");
        return;
      }

      // Step 3: Success!
      onRemindSuccess(remindJson.data);
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Network error during approval and reminder."
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
      aria-labelledby="reminder-approval-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/45 backdrop-blur-xs animate-in fade-in duration-150 overflow-y-auto"
    >
      <div className="relative w-full max-w-xl my-8 rounded-2xl bg-white border-2 border-[#0F6CBD] shadow-2xl p-6 sm:p-8 space-y-6 text-[#12263F] animate-in zoom-in-95 duration-150">
        {/* Close Button */}
        <button
          type="button"
          onClick={onClose}
          disabled={isProcessing}
          aria-label="Close reminder modal"
          className="absolute top-5 right-5 p-2 rounded-xl text-[#5E718D] hover:text-[#12263F] hover:bg-[#F6F5F1] transition-colors disabled:opacity-50 min-h-[44px] min-w-[44px] flex items-center justify-center focus-visible:ring-2 focus-visible:ring-[#0F6CBD] focus-visible:outline-hidden"
        >
          <X className="w-5 h-5" aria-hidden="true" />
        </button>

        {/* Header with Lock Indicator & Consequential Action Badge */}
        <div className="flex items-start gap-3.5 pr-8">
          <div className="p-3 rounded-xl bg-[#EFF6FC] text-[#0F6CBD] border border-[#C7E0F4] shrink-0">
            <Lock className="w-6 h-6 stroke-[2.5]" aria-hidden="true" />
          </div>

          <div className="space-y-1">
            <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-mono font-semibold uppercase tracking-wider text-[#0F6CBD] bg-[#EFF6FC] border border-[#C7E0F4]">
              <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Human Approval Gate · Consequential Action</span>
            </div>
            <h2
              id="reminder-approval-title"
              className="font-headline font-bold text-xl sm:text-2xl text-[#12263F]"
            >
              Approve Payment Reminder
            </h2>
            <p className="text-xs text-[#5E718D] leading-relaxed">
              This action dispatches an official payment reminder notification to the recipient through PayPal Sandbox. This sends a reminder notice, not a new invoice.
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
              <p className="font-semibold">Unable to complete reminder</p>
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
              {invoice.number ?? invoice.id.slice(0, 10)}
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
            <span className="font-mono font-semibold text-[#0F6CBD]">
              {invoice.cashpilotStatus}
            </span>
          </div>

          <div className="flex justify-between py-1 border-b border-[#EEF2F6]">
            <span className="text-[#5E718D]">Due Date:</span>
            <span className="font-mono font-medium text-[#12263F]">
              {new Date(invoice.dueDate).toLocaleDateString()}
            </span>
          </div>

          <div className="flex justify-between py-1 border-b border-[#EEF2F6]">
            <span className="text-[#5E718D]">PayPal Invoice ID:</span>
            <span className="font-mono text-[11px] font-semibold text-[#12263F]">
              {invoice.paypalInvoiceId ?? "None"}
            </span>
          </div>

          <div className="flex justify-between py-1 border-b border-[#EEF2F6] font-semibold text-[#12263F]">
            <span>Outstanding Balance:</span>
            <span className="font-mono tabular-nums text-sm text-[#0C7C61]">
              {formattedTotal}
            </span>
          </div>

          {/* Reminder Content Preview */}
          <div className="pt-1.5 space-y-1.5">
            <span className="text-[11px] font-semibold text-[#5E718D] uppercase tracking-wider">
              Reminder Content Preview
            </span>
            <div className="p-2.5 rounded-lg bg-white border border-[#E3E8EF] space-y-1">
              <p className="text-[11px] font-medium text-[#12263F]">
                <span className="text-[#5E718D]">Subject: </span>
                {defaultSubject}
              </p>
              <p className="text-[11px] text-[#5E718D] italic">
                <span className="not-italic text-[#5E718D]">Note: </span>
                &ldquo;{defaultNote}&rdquo;
              </p>
            </div>
          </div>
        </div>

        {/* Cryptographic Hash Binding Callout */}
        <div className="p-3.5 rounded-xl bg-[#EFF6FC]/80 border border-[#C7E0F4] text-[11px] text-[#0F6CBD] space-y-1">
          <div className="flex items-center gap-1.5 font-semibold">
            <Lock className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>Cryptographic Material Hash Lock</span>
          </div>
          <p className="text-[10px] text-[#12263F]/80 leading-relaxed">
            Approval locks recipient, outstanding amount, dates, and invoice identity to this exact SHA-256 hash. If anything changes, approval is automatically invalidated.
          </p>
          <div className="font-mono text-[10px] bg-white p-2 rounded border border-[#C7E0F4] text-[#12263F] break-all select-all font-semibold">
            {materialPayloadHash}
          </div>
        </div>

        {/* Financial Invariant Reminder */}
        <p className="text-[10px] text-[#5E718D] italic leading-tight">
          Financial Truth: A reminder is purely a notification. It does not alter invoice status, record payment, or modify amounts. Only verified PayPal evidence can mark an invoice as Paid.
        </p>

        {/* Action Controls */}
        <div className="flex flex-col-reverse sm:flex-row items-center justify-end gap-3 pt-2 border-t border-[#E3E8EF]">
          <button
            type="button"
            onClick={onClose}
            disabled={isProcessing}
            className="w-full sm:w-auto px-4 py-2.5 min-h-[44px] rounded-xl border border-[#E3E8EF] text-xs font-semibold text-[#12263F] hover:bg-[#F6F5F1] transition-colors disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-[#0F6CBD] focus-visible:outline-hidden"
          >
            Back to invoice
          </button>

          <button
            type="button"
            onClick={handleApproveAndRemind}
            disabled={isProcessing}
            aria-busy={isProcessing}
            className="w-full sm:w-auto px-5 py-2.5 min-h-[44px] rounded-xl bg-[#0F6CBD] hover:bg-[#0C5494] active:scale-[0.98] text-white text-xs font-semibold shadow-xs transition-all flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-[#0F6CBD] focus-visible:outline-hidden"
          >
            {isProcessing ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin shrink-0" aria-hidden="true" />
                <span>
                  {processingStep === "approving"
                    ? "Validating approval..."
                    : "Sending reminder via PayPal..."}
                </span>
              </>
            ) : (
              <>
                <Bell className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>Approve and send reminder via PayPal</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
