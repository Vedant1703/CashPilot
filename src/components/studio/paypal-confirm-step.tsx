"use client";

import React from "react";
import Link from "next/link";
import { formatMoney } from "@/lib/money";
import { CheckCircle2, ArrowRight, FileText, LayoutGrid, RotateCcw, AlertCircle } from "lucide-react";
import { NaviAvatar } from "@/components/navi/navi-avatar";
import { PersistedStudioInvoice, PayPalDraftResult } from "./types";

interface PayPalConfirmStepProps {
  persistedInvoice: PersistedStudioInvoice;
  paypalResult: PayPalDraftResult | null;
  onReset: () => void;
}

export function PayPalConfirmStep({
  persistedInvoice,
  paypalResult,
  onReset,
}: PayPalConfirmStepProps) {
  const isUnknownOutcome = paypalResult?.status === "UNKNOWN" || paypalResult?.isUnknownOutcome;
  const paypalInvoiceId = paypalResult?.paypalInvoiceId ?? "Pending Reconciliation";
  const formattedTotal = formatMoney(
    persistedInvoice.totalMinorUnits,
    persistedInvoice.currency
  );

  return (
    <div className="max-w-3xl mx-auto space-y-6 animate-in fade-in duration-300">
      {/* Result Card */}
      <div className="rounded-2xl bg-white border border-[#E3E8EF] p-6 sm:p-8 shadow-xs space-y-6">
        {isUnknownOutcome ? (
          /* Timeout / Unknown Outcome State */
          <div className="space-y-4">
            <div className="flex items-start gap-4">
              <div className="p-3 rounded-xl bg-[#FEF6EE] text-[#B54708] border border-[#F9DBAF] shrink-0">
                <AlertCircle className="w-8 h-8" />
              </div>
              <div className="space-y-1">
                <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-[#FEF6EE] text-[#B54708] border border-[#F9DBAF]">
                  Outcome Unknown · Reconciliation Required
                </div>
                <h2 className="font-headline font-bold text-2xl text-[#12263F]">
                  PayPal Response Timed Out
                </h2>
                <p className="text-xs text-[#5E718D] leading-relaxed">
                  The draft creation request was transmitted to PayPal Sandbox, but the network connection timed out before a confirmation was received.
                  Per CashPilot financial integrity rules, we do not blindly retry to prevent duplicate invoices.
                </p>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-[#F6F5F1] border border-[#E3E8EF] text-xs space-y-2">
              <p className="font-medium text-[#12263F]">What to do next:</p>
              <ul className="list-disc pl-5 text-[#5E718D] space-y-1">
                <li>Your local invoice draft is safely preserved in CashPilot.</li>
                <li>Navigate to the invoice details page and click <span className="font-semibold text-[#12263F]">Sync PayPal Status</span> to reconcile with PayPal Sandbox.</li>
              </ul>
            </div>
          </div>
        ) : (
          /* Confirmed Success State */
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-[#E8F5F1] text-[#0C7C61] border border-[#BCE3D6] shrink-0">
                  <CheckCircle2 className="w-7 h-7" />
                </div>
                <div>
                  <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-[#E8F5F1] text-[#0C7C61] border border-[#BCE3D6]">
                    Verified by PayPal Sandbox
                  </div>
                  <h2 className="font-headline font-bold text-2xl text-[#12263F]">
                    PayPal Sandbox Draft Confirmed
                  </h2>
                </div>
              </div>

              {/* Mascot celebrating at top right */}
              <div className="hidden sm:block">
                <NaviAvatar state="idle" size={48} />
              </div>
            </div>

            <p className="text-xs text-[#5E718D] leading-relaxed">
              Your draft invoice has been successfully synchronized and registered with the PayPal Sandbox invoicing system.
              It is stored as an authoritative provider draft. Recipient has <span className="font-semibold text-[#12263F]">not</span> received an email.
            </p>

            {/* Provider Verification Details Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* PayPal Provider Card */}
              <div className="rounded-xl bg-[#F6F5F1]/80 border border-[#E3E8EF] p-4 text-xs space-y-2.5">
                <div className="flex items-center justify-between text-[#5E718D] pb-1 border-b border-[#EEF2F6]">
                  <span className="font-medium">Provider Network</span>
                  <span className="font-mono text-[11px] font-bold text-[#003087]">PayPal Sandbox</span>
                </div>

                <div className="flex items-center justify-between py-1 border-b border-[#EEF2F6]">
                  <span className="text-[#5E718D]">PayPal Draft ID:</span>
                  <span className="font-mono font-semibold text-[#12263F] bg-white px-2 py-0.5 rounded border border-[#E3E8EF]">
                    {paypalInvoiceId}
                  </span>
                </div>

                <div className="flex items-center justify-between py-1 border-b border-[#EEF2F6]">
                  <span className="text-[#5E718D]">Provider Status:</span>
                  <span className="inline-flex items-center gap-1 font-semibold text-[#0C7C61]">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#0C7C61]" />
                    DRAFT
                  </span>
                </div>

                <div className="flex items-center justify-between pt-1">
                  <span className="text-[#5E718D]">External Sync:</span>
                  <span className="text-[#12263F] font-mono text-[11px]">Synchronized Just Now</span>
                </div>
              </div>

              {/* CashPilot Local Draft Card */}
              <div className="rounded-xl bg-white border border-[#E3E8EF] p-4 text-xs space-y-2.5 shadow-2xs">
                <div className="flex items-center justify-between text-[#5E718D] pb-1 border-b border-[#EEF2F6]">
                  <span className="font-medium">CashPilot Workspace</span>
                  <span className="font-mono text-[11px] text-[#5E718D]">{persistedInvoice.workspaceId ?? "demo-workspace-1"}</span>
                </div>

                <div className="flex items-center justify-between py-1 border-b border-[#EEF2F6]">
                  <span className="text-[#5E718D]">Recipient:</span>
                  <span className="font-medium text-[#12263F] truncate max-w-[140px] text-right">
                    {persistedInvoice.client?.name ?? "Client"}
                  </span>
                </div>

                <div className="flex items-center justify-between py-1 border-b border-[#EEF2F6]">
                  <span className="text-[#5E718D]">Local Workflow:</span>
                  <span className="inline-flex items-center gap-1 font-semibold text-[#5B3FD0]">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#5B3FD0]" />
                    DRAFT
                  </span>
                </div>

                <div className="flex items-center justify-between pt-1">
                  <span className="text-[#5E718D]">Authoritative Total:</span>
                  <span className="font-mono font-bold text-[#12263F]">
                    {formattedTotal} {persistedInvoice.currency}
                  </span>
                </div>
              </div>
            </div>

            {/* Invariant reminder banner */}
            <div className="p-3.5 rounded-xl bg-[#F0EEFF] border border-[#CDC4FF] text-xs text-[#5B3FD0] flex items-start gap-2">
              <span className="font-semibold shrink-0">Safe boundary:</span>
              <span>
                In accordance with CashPilot financial governance, draft creation does not trigger invoice dispatch or payment capture.
                To send this invoice to the client, inspect the invoice detail page and perform the authorized send workflow.
              </span>
            </div>
          </div>
        )}

        {/* Action Buttons */}
        <div className="pt-4 border-t border-[#EEF2F6] flex flex-col sm:flex-row items-center justify-between gap-3">
          <button
            type="button"
            onClick={onReset}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl border border-[#E3E8EF] text-xs font-medium text-[#12263F] hover:bg-[#F6F5F1] transition-colors touch-target"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Draft another invoice</span>
          </button>

          <div className="w-full sm:w-auto flex flex-col sm:flex-row items-center gap-2">
            <Link
              href="/collections"
              className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl border border-[#E3E8EF] text-xs font-semibold text-[#12263F] hover:bg-[#F6F5F1] transition-colors touch-target"
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              <span>Collections Board</span>
            </Link>

            <Link
              href={`/invoices/${persistedInvoice.id}`}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-5 py-2.5 rounded-xl bg-[#0C7C61] hover:bg-[#096851] text-white text-xs font-semibold shadow-xs transition-colors touch-target"
            >
              <FileText className="w-3.5 h-3.5" />
              <span>View Invoice Details</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
