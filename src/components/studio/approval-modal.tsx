"use client";

import React, { useState } from "react";
import { formatMoney } from "@/lib/money";
import { ShieldCheck, AlertTriangle, ArrowRight, ArrowLeft, Lock } from "lucide-react";
import { PersistedStudioInvoice, PayPalDraftResult } from "./types";

interface ApprovalModalProps {
  persistedInvoice: PersistedStudioInvoice;
  materialPayloadHash: string;
  onBackToEdit: () => void;
  onPayPalDraftCreated: (paypalResult: PayPalDraftResult) => void;
}

export function ApprovalModal({
  persistedInvoice,
  materialPayloadHash,
  onBackToEdit,
  onPayPalDraftCreated,
}: ApprovalModalProps) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const formattedTotal = formatMoney(
    persistedInvoice.totalMinorUnits,
    persistedInvoice.currency
  );

  const handleApproveAndCreateDraft = async () => {
    setIsProcessing(true);
    setError(null);

    try {
      // 1. Submit Human Approval (SEND_INVOICE) bound to exact material hash
      const approveRes = await fetch(`/api/invoices/${persistedInvoice.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionType: "SEND_INVOICE",
          reviewedPayloadHash: materialPayloadHash,
        }),
      });

      const approveJson = await approveRes.json();
      if (!approveRes.ok || !approveJson.success) {
        setError(approveJson.error || "Approval rejected by server.");
        setIsProcessing(false);
        return;
      }

      const approvalId = approveJson.data.approvalId;

      // 2. Request PayPal Sandbox Draft Creation
      const draftRes = await fetch(`/api/invoices/${persistedInvoice.id}/paypal-draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvalId }),
      });

      const draftJson = await draftRes.json();
      if (!draftRes.ok || !draftJson.success) {
        setError(draftJson.error || "PayPal draft creation failed.");
        setIsProcessing(false);
        return;
      }

      // Success: proceed to confirmation step
      onPayPalDraftCreated(draftJson.data);
    } catch {
      setError("Network error while communicating with approval service.");
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6 animate-in fade-in duration-200">
      {/* Approval Sheet Card (Orange Accent Theme #B4440B) */}
      <div className="rounded-2xl bg-white border-2 border-[#B4440B] p-6 sm:p-8 shadow-lg space-y-6">
        {/* Header with Lock Indicator */}
        <div className="flex items-start gap-4">
          <div className="p-3 rounded-xl bg-[#FDF2EB] text-[#B4440B] border border-[#F7C4A5] shrink-0">
            <Lock className="w-6 h-6 stroke-[2.5]" />
          </div>

          <div className="space-y-1">
            <span className="text-[11px] font-mono font-semibold uppercase tracking-wider text-[#B4440B] px-2 py-0.5 rounded-full bg-[#FDF2EB] border border-[#F7C4A5]">
              Human Approval Gate
            </span>
            <h2 className="font-headline font-bold text-2xl text-[#12263F]">
              Needs your approval
            </h2>
            <p className="text-xs text-[#5E718D] leading-relaxed">
              This action creates an authentic draft invoice in the PayPal Sandbox environment. No email is sent to your client yet.
            </p>
          </div>
        </div>

        {error && (
          <div className="p-4 rounded-xl bg-[#FEF3F2] border border-[#FECDCA] text-[#B42318] text-xs flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* Material Summary Table */}
        <div className="rounded-xl bg-[#F6F5F1]/80 border border-[#E3E8EF] p-4 text-xs space-y-2.5">
          <div className="flex justify-between py-1 border-b border-[#EEF2F6]">
            <span className="text-[#5E718D]">Invoice Number:</span>
            <span className="font-mono font-semibold text-[#12263F]">
              {persistedInvoice.number ?? persistedInvoice.id.slice(0, 10)}
            </span>
          </div>

          <div className="flex justify-between py-1 border-b border-[#EEF2F6]">
            <span className="text-[#5E718D]">Recipient Client:</span>
            <span className="font-medium text-[#12263F]">{persistedInvoice.client?.name}</span>
          </div>

          <div className="flex justify-between py-1 border-b border-[#EEF2F6]">
            <span className="text-[#5E718D]">Recipient Email:</span>
            <span className="font-mono text-[#12263F]">{persistedInvoice.client?.email}</span>
          </div>

          <div className="flex justify-between py-1 border-b border-[#EEF2F6]">
            <span className="text-[#5E718D]">Due Date:</span>
            <span className="font-mono font-medium text-[#12263F]">
              {new Date(persistedInvoice.dueDate).toLocaleDateString()}
            </span>
          </div>

          <div className="flex justify-between pt-1 font-bold text-sm text-[#12263F]">
            <span>Locked Total Amount:</span>
            <span className="font-mono tabular-nums text-base text-[#0C7C61]">
              {formattedTotal} {persistedInvoice.currency}
            </span>
          </div>
        </div>

        {/* Cryptographic Hash Binding Callout */}
        <div className="p-4 rounded-xl bg-[#FDF2EB]/70 border border-[#F7C4A5] text-xs space-y-2">
          <div className="flex items-center gap-1.5 font-semibold text-[#B4440B]">
            <ShieldCheck className="w-4 h-4" />
            <span>Cryptographic Payload Integrity</span>
          </div>
          <p className="text-[#5E718D] leading-relaxed">
            Your approval covers exactly this reviewed snapshot. Recipient, total amount, line items, and dates are bound to SHA-256 hash:
          </p>
          <div className="font-mono text-[11px] p-2 rounded-lg bg-white border border-[#F7C4A5] text-[#12263F] break-all select-all">
            {materialPayloadHash}
          </div>
          <p className="text-[11px] text-[#B4440B] font-medium italic">
            If any material field changes after approval, the approval is invalidated and must be reviewed again.
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2">
          <button
            type="button"
            onClick={onBackToEdit}
            disabled={isProcessing}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl border border-[#E3E8EF] text-xs font-medium text-[#12263F] hover:bg-[#F6F5F1] transition-colors disabled:opacity-50 touch-target"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Back to edit draft</span>
          </button>

          <button
            type="button"
            onClick={handleApproveAndCreateDraft}
            disabled={isProcessing}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-2.5 rounded-xl bg-[#B4440B] hover:bg-[#963809] text-white text-xs font-semibold shadow-md transition-colors disabled:opacity-50 touch-target focus-visible:ring-2 focus-visible:ring-[#B4440B]"
          >
            {isProcessing ? (
              <>
                <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                <span>Contacting PayPal Sandbox...</span>
              </>
            ) : (
              <>
                <ShieldCheck className="w-4 h-4" />
                <span>Approve & Create PayPal Draft</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
