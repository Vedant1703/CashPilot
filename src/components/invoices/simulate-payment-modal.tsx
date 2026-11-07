"use client";

import React, { useState, useEffect } from "react";
import { formatMoney } from "@/lib/money";
import { Sparkles, ShieldAlert, CheckCircle2, AlertTriangle, X, RefreshCw } from "lucide-react";
import { SerializedInvoiceDetail } from "./invoice-detail-view";
import { CashPilotStatus } from "@prisma/client";

interface SimulatePaymentModalProps {
  invoice: SerializedInvoiceDetail;
  isOpen: boolean;
  onClose: () => void;
  onSimulateSuccess: (result: {
    invoiceId: string;
    paymentProvenance: string;
    cashpilotStatus: CashPilotStatus;
    simulatedAmountMinorUnits: number;
    simulatedPaymentAt: string;
    simulatedRef: string;
  }) => void;
}

export function SimulatePaymentModal({
  invoice,
  isOpen,
  onClose,
  onSimulateSuccess,
}: SimulatePaymentModalProps) {
  const [isProcessing, setIsProcessing] = useState(false);
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

  const handleSimulate = async () => {
    if (isProcessing) return;

    setIsProcessing(true);
    setError(null);

    try {
      const res = await fetch(`/api/invoices/${invoice.id}/simulate-payment`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-workspace-id": invoice.workspaceId,
        },
      });

      const json = await res.json();

      if (!res.ok || !json.success) {
        setError(json.error || "Simulation failed. Please try again.");
        setIsProcessing(false);
        return;
      }

      onSimulateSuccess({
        invoiceId: json.data.invoiceId,
        paymentProvenance: json.data.paymentProvenance,
        cashpilotStatus: json.data.cashpilotStatus,
        simulatedAmountMinorUnits: json.data.simulatedAmountMinorUnits,
        simulatedPaymentAt: json.data.simulatedPaymentAt,
        simulatedRef: json.data.simulatedRef,
      });

      setIsProcessing(false);
      onClose();
    } catch (err) {
      console.error("Simulation error:", err);
      setError("An unexpected network error occurred while simulating payment.");
      setIsProcessing(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="simulate-payment-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 overflow-y-auto bg-black/50 backdrop-blur-xs animate-in fade-in duration-150"
    >
      <div className="relative w-full max-w-lg rounded-2xl bg-white border border-[#E3E8EF] shadow-2xl p-6 sm:p-7 space-y-5">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#F0FDF4] border border-[#DCFCE7] flex items-center justify-center text-[#16A34A] shrink-0">
              <Sparkles className="w-5 h-5 text-[#16A34A]" />
            </div>
            <div>
              <h2
                id="simulate-payment-modal-title"
                className="text-lg font-bold text-[#12263F]"
              >
                Simulate Demo Payment
              </h2>
              <p className="text-xs text-[#5E718D] mt-0.5">
                Eligible Demo Workspace invoice completion
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isProcessing}
            aria-label="Close dialog"
            className="p-1.5 rounded-lg text-[#5E718D] hover:bg-[#F4F6F8] transition-colors disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Prominent Demo Notice Banner */}
        <div className="rounded-xl bg-[#F0FDF4] border border-[#BBF7D0] p-4 text-[#166534]">
          <div className="flex items-center gap-2 font-bold text-xs uppercase tracking-wider">
            <CheckCircle2 className="w-4 h-4 shrink-0 text-[#16A34A]" />
            <span>SIMULATED — NO REAL MONEY MOVED</span>
          </div>
          <p className="text-xs mt-1.5 leading-relaxed text-[#14532D]">
            This action simulates payment completion strictly within the Demo Workspace so you can demonstrate the complete receivables lifecycle without moving real or Sandbox funds.
          </p>
        </div>

        {/* Invoice Summary Details */}
        <div className="rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] p-4 space-y-2.5 text-xs text-[#334155]">
          <div className="flex justify-between items-center">
            <span className="text-[#64748B] font-medium">Invoice Number:</span>
            <span className="font-semibold text-[#0F172A] font-mono">{invoiceIdentifier}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-[#64748B] font-medium">Client:</span>
            <span className="font-semibold text-[#0F172A]">{invoice.client.name}</span>
          </div>
          <div className="flex justify-between items-center pt-2 border-t border-[#E2E8F0]">
            <span className="text-[#64748B] font-medium">Simulated Amount:</span>
            <span className="text-sm font-bold text-[#0F172A] font-mono">{formattedTotal}</span>
          </div>
        </div>

        {/* Financial Safety Guarantees */}
        <div className="rounded-xl bg-[#FEF3F2] border border-[#FECDCA] p-3.5 space-y-2 text-[11px] text-[#912018]">
          <div className="flex items-center gap-1.5 font-bold uppercase tracking-wide text-[#B42318]">
            <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
            <span>Financial Integrity & Safety Invariants</span>
          </div>
          <ul className="list-disc pl-4 space-y-1 leading-relaxed">
            <li>No PayPal API calls will be made; zero external transactions execute.</li>
            <li>PayPal provider status is not fabricated or modified to Paid.</li>
            <li>Simulated amount is locked to the persisted server total ({formattedTotal}).</li>
            <li>Audit history will explicitly record this as a local simulation.</li>
          </ul>
        </div>

        {/* Error Alert */}
        {error && (
          <div
            role="alert"
            className="rounded-xl bg-[#FEF3F2] border border-[#FDA29B] p-3 text-xs text-[#B42318] flex items-start gap-2 animate-in fade-in"
          >
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="flex-1 leading-relaxed">{error}</div>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex flex-col-reverse sm:flex-row items-center justify-end gap-2.5 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isProcessing}
            className="w-full sm:w-auto px-4 py-2 min-h-[44px] rounded-xl border border-[#E3E8EF] text-xs font-semibold text-[#5E718D] hover:bg-[#F4F6F8] transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSimulate}
            disabled={isProcessing}
            aria-label="Confirm simulated payment"
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[44px] rounded-xl bg-[#16A34A] hover:bg-[#15803D] text-white text-xs font-bold shadow-xs active:scale-[0.98] transition-all focus-visible:ring-2 focus-visible:ring-[#16A34A] focus-visible:outline-hidden disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isProcessing ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0" />
                <span>Simulating payment...</span>
              </>
            ) : (
              <>
                <Sparkles className="w-3.5 h-3.5 shrink-0" />
                <span>Confirm Simulation ({formattedTotal})</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
