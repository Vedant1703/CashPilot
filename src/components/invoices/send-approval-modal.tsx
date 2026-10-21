"use client";

import React, { useState, useEffect } from "react";
import { formatMoney } from "@/lib/money";
import { Lock, AlertTriangle, Send, X, ShieldCheck, RefreshCw } from "lucide-react";
import { SerializedInvoiceDetail } from "./invoice-detail-view";
import { CashPilotStatus } from "@prisma/client";

interface SendApprovalModalProps {
  invoice: SerializedInvoiceDetail;
  materialPayloadHash: string;
  isOpen: boolean;
  onClose: () => void;
  onSendSuccess: (sendResult: {
    operationId: string;
    invoiceId: string;
    paypalInvoiceId: string;
    paypalStatus: string;
    cashpilotStatus: CashPilotStatus;
    sentAt: string;
    correlationId?: string;
  }) => void;
}

export function SendApprovalModal({
  invoice,
  materialPayloadHash,
  isOpen,
  onClose,
  onSendSuccess,
}: SendApprovalModalProps) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStep, setProcessingStep] = useState<"idle" | "approving" | "sending">("idle");
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
  const formattedSubtotal = formatMoney(invoice.subtotalMinorUnits, invoice.currency);
  const formattedTax = formatMoney(invoice.taxMinorUnits, invoice.currency);

  const handleApproveAndSend = async () => {
    // Prevent duplicate concurrent submissions
    if (isProcessing) return;

    setIsProcessing(true);
    setProcessingStep("approving");
    setError(null);

    try {
      // Step 1: Submit Human Approval (SEND_INVOICE) bound to exact material hash
      const approveRes = await fetch(`/api/invoices/${invoice.id}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-workspace-id": invoice.workspaceId,
        },
        body: JSON.stringify({
          actionType: "SEND_INVOICE",
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

      // Step 2: Execute send operation with confirmed approval ID
      setProcessingStep("sending");
      const sendRes = await fetch(`/api/invoices/${invoice.id}/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-workspace-id": invoice.workspaceId,
        },
        body: JSON.stringify({ approvalId }),
      });

      const sendJson = await sendRes.json();

      if (!sendRes.ok || !sendJson.success) {
        if (sendRes.status === 504 || sendJson.code === "OPERATION_UNKNOWN_OUTCOME") {
          setError(
            "PayPal Sandbox request timed out. Outcome is unknown; no blind retry will be made. Please click 'Sync status' to reconcile before retrying."
          );
        } else if (sendRes.status === 409) {
          setError(
            sendJson.error ||
              "A conflicting operation or stale approval was detected. Please refresh."
          );
        } else {
          setError(sendJson.error || "Failed to send invoice through PayPal Sandbox.");
        }
        setIsProcessing(false);
        setProcessingStep("idle");
        return;
      }

      // Step 3: Success!
      onSendSuccess(sendJson.data);
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Network error during approval and sending."
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
      aria-labelledby="send-approval-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/45 backdrop-blur-xs animate-in fade-in duration-150 overflow-y-auto"
    >
      <div className="relative w-full max-w-xl my-8 rounded-2xl bg-white border-2 border-[#B4440B] shadow-2xl p-6 sm:p-8 space-y-6 text-[#12263F] animate-in zoom-in-95 duration-150">
        {/* Close Button */}
        <button
          type="button"
          onClick={onClose}
          disabled={isProcessing}
          aria-label="Close approval modal"
          className="absolute top-5 right-5 p-2 rounded-xl text-[#5E718D] hover:text-[#12263F] hover:bg-[#F6F5F1] transition-colors disabled:opacity-50 min-h-[44px] min-w-[44px] flex items-center justify-center focus-visible:ring-2 focus-visible:ring-[#B4440B] focus-visible:outline-hidden"
        >
          <X className="w-5 h-5" aria-hidden="true" />
        </button>

        {/* Header with Lock Indicator & Consequential Orange Theme */}
        <div className="flex items-start gap-3.5 pr-8">
          <div className="p-3 rounded-xl bg-[#FDF2EB] text-[#B4440B] border border-[#F7C4A5] shrink-0">
            <Lock className="w-6 h-6 stroke-[2.5]" aria-hidden="true" />
          </div>

          <div className="space-y-1">
            <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-mono font-semibold uppercase tracking-wider text-[#B4440B] bg-[#FDF2EB] border border-[#F7C4A5]">
              <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Human Approval Gate · Consequential Action</span>
            </div>
            <h2
              id="send-approval-title"
              className="font-headline font-bold text-xl sm:text-2xl text-[#12263F]"
            >
              Approve and Send Invoice
            </h2>
            <p className="text-xs text-[#5E718D] leading-relaxed">
              This action officially dispatches the invoice through the PayPal Sandbox Invoicing API. The recipient will receive an invoice notice.
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
              <p className="font-semibold">Unable to complete send</p>
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
            <span className="text-[#5E718D]">Due Date:</span>
            <span className="font-mono font-medium text-[#12263F]">
              {new Date(invoice.dueDate).toLocaleDateString()}
            </span>
          </div>

          <div className="flex justify-between py-1 border-b border-[#EEF2F6]">
            <span className="text-[#5E718D]">PayPal Draft ID:</span>
            <span className="font-mono text-[11px] font-semibold text-[#12263F]">
              {invoice.paypalInvoiceId ?? "None"}
            </span>
          </div>

          {/* Line items mini-summary */}
          <div className="py-1 border-b border-[#EEF2F6]">
            <div className="flex justify-between text-[#5E718D] mb-1">
              <span>Line Items ({invoice.lineItems.length}):</span>
              <span className="font-mono tabular-nums">{formattedSubtotal}</span>
            </div>
            <ul className="space-y-1 pl-2 text-[11px] text-[#5E718D]">
              {invoice.lineItems.slice(0, 3).map((item) => (
                <li key={item.id} className="flex justify-between">
                  <span className="truncate max-w-[200px]">
                    {item.quantity}× {item.description}
                  </span>
                  <span className="font-mono tabular-nums text-[#12263F]">
                    {formatMoney(item.totalMinorUnits, invoice.currency)}
                  </span>
                </li>
              ))}
              {invoice.lineItems.length > 3 && (
                <li className="italic text-[10px] text-[#5E718D]">
                  +{invoice.lineItems.length - 3} more line item(s)
                </li>
              )}
            </ul>
          </div>

          {invoice.taxMinorUnits > 0 && (
            <div className="flex justify-between py-1 border-b border-[#EEF2F6] text-[#5E718D]">
              <span>Tax ({(invoice.taxRateBasisPoints / 100).toFixed(1)}%):</span>
              <span className="font-mono tabular-nums">{formattedTax}</span>
            </div>
          )}

          <div className="flex justify-between pt-1.5 font-bold text-sm text-[#12263F]">
            <span>Total Authoritative Amount:</span>
            <span className="font-mono tabular-nums text-base text-[#0C7C61]">
              {formattedTotal}
            </span>
          </div>
        </div>

        {/* Cryptographic Hash Binding Callout */}
        <div className="p-3.5 rounded-xl bg-[#FDF2EB]/80 border border-[#F7C4A5] text-[11px] text-[#B4440B] space-y-1">
          <div className="flex items-center gap-1.5 font-semibold">
            <Lock className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>Cryptographic Material Hash Lock</span>
          </div>
          <p className="text-[10px] text-[#7A5600] leading-relaxed">
            Approval locks recipient, amount, line items, and dates to this exact SHA-256 hash. If anything changes, approval is automatically invalidated.
          </p>
          <div className="font-mono text-[10px] bg-white p-2 rounded border border-[#F7C4A5] text-[#12263F] break-all select-all font-semibold">
            {materialPayloadHash}
          </div>
        </div>

        {/* Financial Invariant Reminder */}
        <p className="text-[10px] text-[#5E718D] italic leading-tight">
          Financial Truth: A successful send transitions status to Awaiting Payment. Only verified PayPal payment confirmation will establish a Paid status.
        </p>

        {/* Action Controls */}
        <div className="flex flex-col-reverse sm:flex-row items-center justify-end gap-3 pt-2 border-t border-[#E3E8EF]">
          <button
            type="button"
            onClick={onClose}
            disabled={isProcessing}
            className="w-full sm:w-auto px-4 py-2.5 min-h-[44px] rounded-xl border border-[#E3E8EF] text-xs font-semibold text-[#12263F] hover:bg-[#F6F5F1] transition-colors disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-[#B4440B] focus-visible:outline-hidden"
          >
            Back to invoice
          </button>

          <button
            type="button"
            onClick={handleApproveAndSend}
            disabled={isProcessing}
            aria-busy={isProcessing}
            className="w-full sm:w-auto px-5 py-2.5 min-h-[44px] rounded-xl bg-[#B4440B] hover:bg-[#933708] active:scale-[0.98] text-white text-xs font-semibold shadow-xs transition-all flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-[#B4440B] focus-visible:outline-hidden"
          >
            {isProcessing ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin shrink-0" aria-hidden="true" />
                <span>
                  {processingStep === "approving"
                    ? "Validating approval..."
                    : "Sending via PayPal Sandbox..."}
                </span>
              </>
            ) : (
              <>
                <Send className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>Approve and send via PayPal</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
