"use client";

import React, { useState } from "react";
import { Sparkles, Info, Copy, Check } from "lucide-react";
import { formatMoney } from "@/lib/money";

export interface SimulatedPaymentSummaryCardProps {
  paymentProvenance?: string | null;
  cashpilotStatus?: string | null;
  simulatedAmountMinorUnits?: number | null;
  totalMinorUnits: number;
  currency: string;
  simulatedPaymentAt?: string | null;
  simulatedRef?: string | null;
}

export function SimulatedPaymentSummaryCard({
  paymentProvenance,
  cashpilotStatus,
  simulatedAmountMinorUnits,
  totalMinorUnits,
  currency,
  simulatedPaymentAt,
  simulatedRef,
}: SimulatedPaymentSummaryCardProps) {
  const [copied, setCopied] = useState(false);

  // Only render if invoice is simulated
  const isSimulated =
    paymentProvenance === "SIMULATED_DEMO_PAYMENT" ||
    cashpilotStatus === "SIMULATED_PAID";

  if (!isSimulated) {
    return null;
  }

  const amountMinorUnits = simulatedAmountMinorUnits ?? totalMinorUnits;
  const formattedAmount = formatMoney(amountMinorUnits, currency);

  const formattedDate = simulatedPaymentAt
    ? new Date(simulatedPaymentAt).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      })
    : "Simulated";

  const handleCopyRef = async () => {
    if (!simulatedRef) return;
    try {
      await navigator.clipboard.writeText(simulatedRef);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  };

  return (
    <section
      aria-label="Demo Payment Simulation Summary"
      className="rounded-2xl border border-[#BBF7D0] bg-[#F0FDF4] p-5 shadow-xs space-y-4"
    >
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-[#BBF7D0]/60 pb-3">
        <div className="flex items-center gap-2.5">
          <span className="p-1.5 rounded-xl bg-[#DCFCE7] text-[#16A34A]">
            <Sparkles className="w-4 h-4 text-[#16A34A]" />
          </span>
          <div>
            <h3 className="font-bold text-sm text-[#14532D]">
              Demo Payment Simulation
            </h3>
            <p className="text-xs text-[#166534]">
              Simulated completion · strictly confined to Demo Workspace
            </p>
          </div>
        </div>

        <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-[#166534] bg-[#DCFCE7] border border-[#86EFAC] px-3 py-1 rounded-full w-fit">
          <span className="w-1.5 h-1.5 rounded-full bg-[#16A34A]" />
          SIMULATED — NO REAL MONEY MOVED
        </span>
      </div>

      {/* Grid of Simulation Metadata */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
        {/* Simulated Amount */}
        <div className="rounded-xl bg-white border border-[#BBF7D0] p-3 space-y-1">
          <span className="text-[10px] uppercase font-bold text-[#4B7C59] tracking-wider">
            Simulated Amount
          </span>
          <div className="text-base font-bold text-[#14532D] font-mono">
            {formattedAmount}
          </div>
          <span className="text-[10px] text-[#4B7C59] block">
            Locked to invoice total
          </span>
        </div>

        {/* Simulation Reference */}
        <div className="rounded-xl bg-white border border-[#BBF7D0] p-3 space-y-1">
          <span className="text-[10px] uppercase font-bold text-[#4B7C59] tracking-wider">
            Simulation Reference
          </span>
          <div className="flex items-center justify-between gap-1">
            <span className="text-xs font-semibold text-[#14532D] font-mono truncate">
              {simulatedRef ?? "SIM-DEMO-RECORD"}
            </span>
            {simulatedRef && (
              <button
                type="button"
                onClick={handleCopyRef}
                aria-label="Copy simulation reference"
                className="p-1 rounded text-[#16A34A] hover:bg-[#DCFCE7] transition-colors shrink-0"
              >
                {copied ? (
                  <Check className="w-3.5 h-3.5 text-[#16A34A]" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </button>
            )}
          </div>
          <span className="text-[10px] text-[#4B7C59] block">
            Demo audit identifier
          </span>
        </div>

        {/* Timestamp */}
        <div className="rounded-xl bg-white border border-[#BBF7D0] p-3 space-y-1">
          <span className="text-[10px] uppercase font-bold text-[#4B7C59] tracking-wider">
            Simulated At
          </span>
          <div className="text-xs font-semibold text-[#14532D]">
            {formattedDate}
          </div>
          <span className="text-[10px] text-[#4B7C59] block">
            Local workstation time
          </span>
        </div>

        {/* Actor */}
        <div className="rounded-xl bg-white border border-[#BBF7D0] p-3 space-y-1">
          <span className="text-[10px] uppercase font-bold text-[#4B7C59] tracking-wider">
            Simulation Actor
          </span>
          <div className="text-xs font-semibold text-[#14532D]">
            Demo User
          </div>
          <span className="text-[10px] text-[#4B7C59] block">
            demo-user-1 (interactive)
          </span>
        </div>
      </div>

      {/* Safety Notice Callout */}
      <div className="rounded-xl bg-[#DCFCE7]/60 border border-[#86EFAC] p-3 flex items-start gap-2.5 text-xs text-[#14532D]">
        <Info className="w-4 h-4 shrink-0 mt-0.5 text-[#16A34A]" />
        <div className="space-y-0.5 leading-relaxed text-[11px]">
          <p className="font-semibold">
            Strict Separation of Provider and Workflow Status:
          </p>
          <p className="text-[#166534]">
            This simulation does not contact PayPal or alter the remote PayPal invoice status. Only verified provider evidence can establish a true PayPal-verified payment.
          </p>
        </div>
      </div>
    </section>
  );
}
