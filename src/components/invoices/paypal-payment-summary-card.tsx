"use client";

import React, { useState } from "react";
import {
  ShieldCheck,
  AlertTriangle,
  AlertCircle,
  Copy,
  Check,
  ExternalLink,
} from "lucide-react";
import {
  extractPayPalPaymentDetails,
  type PayPalPaymentSummary,
} from "@/lib/paypal/payment-details";

export interface PayPalPaymentSummaryCardProps {
  paypalStatusRaw?: unknown;
  paypalStatus?: string | null;
  currency: string;
  paypalInvoiceId?: string | null;
  paypalPayerViewUrl?: string | null;
  lastSyncAt?: string | null;
}

export function PayPalPaymentSummaryCard({
  paypalStatusRaw,
  paypalStatus,
  currency,
  paypalPayerViewUrl,
}: PayPalPaymentSummaryCardProps) {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const summary: PayPalPaymentSummary = extractPayPalPaymentDetails(
    paypalStatusRaw,
    paypalStatus,
    currency
  );

  // If no payment or refund data exists, do not render a payment card
  if (!summary.hasPaymentData) {
    return null;
  }

  const handleCopy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(key);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // Clipboard copy fallback
    }
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Fully Paid State
  // ─────────────────────────────────────────────────────────────────────────────
  if (summary.isPaid) {
    return (
      <section
        aria-label="PayPal Payment Verification"
        className="rounded-2xl border border-[#A3D9CC] bg-[#F0FAF7] p-5 shadow-xs space-y-4"
      >
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-[#A3D9CC]/50 pb-3">
          <div className="flex items-center gap-2">
            <span className="p-1 rounded-lg bg-[#E8F5F1] text-[#0C7C61]">
              <ShieldCheck className="w-4 h-4" />
            </span>
            <div>
              <h3 className="font-semibold text-sm text-[#0C7C61]">
                PayPal Payment Verification
              </h3>
              <p className="text-xs text-[#5E718D]">
                Verified by PayPal Invoicing API in Sandbox
              </p>
            </div>
          </div>
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#0C7C61] bg-[#E8F5F1] border border-[#A3D9CC] px-2.5 py-1 rounded-full w-fit">
            <span className="w-1.5 h-1.5 rounded-full bg-[#0C7C61]" />
            <span>PayPal-Verified</span>
          </span>
        </div>

        {/* Core Payment Metrics Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
          {/* Amount Paid */}
          <div className="p-3 rounded-xl bg-white/80 border border-[#A3D9CC]/40 space-y-1">
            <span className="text-[11px] font-medium text-[#5E718D] uppercase tracking-wider block">
              Actual Amount Paid
            </span>
            {summary.paidAmountFormatted ? (
              <span className="font-mono text-base font-bold text-[#0C7C61] block tabular-nums">
                {summary.paidAmountFormatted}
              </span>
            ) : (
              <span className="text-xs text-[#5E718D] italic block">
                Not specified in provider payload
              </span>
            )}
            <span className="text-[10px] text-[#5E718D]">
              Directly reported by PayPal
            </span>
          </div>

          {/* Provider Status */}
          <div className="p-3 rounded-xl bg-white/80 border border-[#A3D9CC]/40 space-y-1">
            <span className="text-[11px] font-medium text-[#5E718D] uppercase tracking-wider block">
              Provider Status
            </span>
            <span className="font-mono text-sm font-bold text-[#12263F] block">
              {summary.rawStatus ?? "PAID"}
            </span>
            <span className="text-[10px] text-[#5E718D]">
              Full settlement confirmed
            </span>
          </div>

          {/* Transaction / Reference ID */}
          <div className="p-3 rounded-xl bg-white/80 border border-[#A3D9CC]/40 space-y-1">
            <span className="text-[11px] font-medium text-[#5E718D] uppercase tracking-wider block">
              Transaction Reference
            </span>
            {summary.primaryTransactionId ? (
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs font-semibold text-[#12263F] truncate">
                  {summary.primaryTransactionId}
                </span>
                <button
                  type="button"
                  onClick={() => handleCopy(summary.primaryTransactionId!, "primary_tx")}
                  aria-label="Copy transaction ID"
                  className="p-1 rounded-md hover:bg-[#F6F5F1] text-[#5E718D] shrink-0"
                >
                  {copiedId === "primary_tx" ? (
                    <Check className="w-3.5 h-3.5 text-[#0C7C61]" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            ) : (
              <span className="text-xs text-[#5E718D] italic block">
                Not supplied by provider
              </span>
            )}
            <span className="text-[10px] text-[#5E718D]">
              PayPal capture / transaction reference
            </span>
          </div>

          {/* Payment Date & Method */}
          <div className="p-3 rounded-xl bg-white/80 border border-[#A3D9CC]/40 space-y-1">
            <span className="text-[11px] font-medium text-[#5E718D] uppercase tracking-wider block">
              Payment Date & Method
            </span>
            <span className="text-xs font-medium text-[#12263F] block">
              {summary.primaryPaymentDate ?? (
                <span className="text-[#5E718D] italic">Not supplied by provider</span>
              )}
            </span>
            <span className="text-[10px] text-[#5E718D]">
              Method: {summary.primaryPaymentMethod ?? "PayPal"}
            </span>
          </div>
        </div>

        {/* Transaction Note (if present) */}
        {summary.paymentTransactions.length === 1 && summary.paymentTransactions[0].note && (
          <div className="p-2.5 rounded-xl bg-white/70 border border-[#A3D9CC]/40 text-xs text-[#5E718D]">
            <span className="font-semibold text-[#12263F]">Payment Note: </span>
            <span>{summary.paymentTransactions[0].note}</span>
          </div>
        )}

        {/* Multi-transaction breakdown (if multiple transactions exist) */}
        {summary.paymentTransactions.length > 1 && (
          <div className="pt-2 border-t border-[#A3D9CC]/50 space-y-2">
            <h4 className="text-xs font-semibold text-[#12263F]">
              Recorded Payment Transactions ({summary.paymentTransactions.length})
            </h4>
            <div className="divide-y divide-[#EEF2F6] rounded-xl border border-[#A3D9CC]/40 bg-white/60 overflow-hidden text-xs">
              {summary.paymentTransactions.map((tx, idx) => (
                <div key={tx.id || idx} className="p-2.5 flex items-center justify-between gap-3">
                  <div>
                    <span className="font-mono font-medium text-[#12263F]">
                      {tx.id ?? `Payment #${idx + 1}`}
                    </span>
                    {tx.formattedDate && (
                      <span className="text-[11px] text-[#5E718D] ml-2">
                        {tx.formattedDate}
                      </span>
                    )}
                  </div>
                  <span className="font-mono font-semibold text-[#0C7C61]">
                    {tx.amountFormatted ?? "Amount not specified"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer Actions & Invariants */}
        <div className="pt-2 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-[11px] text-[#5E718D]">
          <p className="italic">
            Payment verified by PayPal Sandbox. Totals are never derived from AI or local actions.
          </p>
          {paypalPayerViewUrl && (
            <a
              href={paypalPayerViewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-semibold text-[#0C7C61] hover:underline shrink-0"
            >
              <span>View hosted PayPal receipt</span>
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      </section>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Partially Paid State
  // ─────────────────────────────────────────────────────────────────────────────
  if (summary.isPartiallyPaid) {
    return (
      <section
        aria-label="PayPal Partial Payment Notice"
        className="rounded-2xl border border-[#F3E0A2] bg-[#FEFDF8] p-5 shadow-xs space-y-4"
      >
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-[#F3E0A2]/60 pb-3">
          <div className="flex items-center gap-2">
            <span className="p-1 rounded-lg bg-[#FEF9E7] text-[#7A5600]">
              <AlertTriangle className="w-4 h-4" />
            </span>
            <div>
              <h3 className="font-semibold text-sm text-[#7A5600]">
                Partial Payment Received
              </h3>
              <p className="text-xs text-[#5E718D]">
                Provider reports partial payment · Action requires review
              </p>
            </div>
          </div>
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#7A5600] bg-[#FEF9E7] border border-[#F3E0A2] px-2.5 py-1 rounded-full w-fit">
            <span className="w-1.5 h-1.5 rounded-full bg-[#7A5600]" />
            <span>Requires Review</span>
          </span>
        </div>

        {/* Explainer Banner */}
        <div className="p-3 rounded-xl bg-[#FEF9E7]/60 border border-[#F3E0A2] text-xs text-[#7A5600] leading-relaxed">
          PayPal Sandbox reports that a partial payment was received for this invoice. An outstanding balance remains due. CashPilot never marks partially paid invoices as fully Paid.
        </div>

        {/* Metrics Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
          {/* Amount Received */}
          <div className="p-3 rounded-xl bg-white border border-[#F3E0A2]/50 space-y-1">
            <span className="text-[11px] font-medium text-[#5E718D] uppercase tracking-wider block">
              Amount Received
            </span>
            {summary.paidAmountFormatted ? (
              <span className="font-mono text-base font-bold text-[#7A5600] block tabular-nums">
                {summary.paidAmountFormatted}
              </span>
            ) : (
              <span className="text-xs text-[#5E718D] italic block">
                Not specified in provider payload
              </span>
            )}
            <span className="text-[10px] text-[#5E718D]">
              Verified partial payment
            </span>
          </div>

          {/* Outstanding Balance */}
          <div className="p-3 rounded-xl bg-white border border-[#F3E0A2]/50 space-y-1">
            <span className="text-[11px] font-medium text-[#5E718D] uppercase tracking-wider block">
              Outstanding Balance
            </span>
            {summary.dueAmountFormatted ? (
              <span className="font-mono text-base font-bold text-[#B42318] block tabular-nums">
                {summary.dueAmountFormatted}
              </span>
            ) : (
              <span className="text-xs text-[#5E718D] italic block">
                Not specified by provider
              </span>
            )}
            <span className="text-[10px] text-[#5E718D]">
              Remaining due on PayPal
            </span>
          </div>

          {/* Transaction Reference (if present) */}
          {summary.primaryTransactionId && (
            <div className="p-3 rounded-xl bg-white border border-[#F3E0A2]/50 space-y-1 sm:col-span-2">
              <span className="text-[11px] font-medium text-[#5E718D] uppercase tracking-wider block">
                Partial Payment Transaction ID
              </span>
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs font-semibold text-[#12263F]">
                  {summary.primaryTransactionId}
                </span>
                <button
                  type="button"
                  onClick={() => handleCopy(summary.primaryTransactionId!, "partial_tx")}
                  aria-label="Copy partial payment transaction ID"
                  className="p-1 rounded-md hover:bg-[#F6F5F1] text-[#5E718D]"
                >
                  {copiedId === "partial_tx" ? (
                    <Check className="w-3.5 h-3.5 text-[#7A5600]" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Transactions list if multiple */}
        {summary.paymentTransactions.length > 0 && (
          <div className="pt-2 border-t border-[#F3E0A2]/60 space-y-2">
            <h4 className="text-xs font-semibold text-[#12263F]">
              Partial Payments Received ({summary.paymentTransactions.length})
            </h4>
            <div className="divide-y divide-[#EEF2F6] rounded-xl border border-[#F3E0A2]/50 bg-white overflow-hidden text-xs">
              {summary.paymentTransactions.map((tx, idx) => (
                <div key={tx.id || idx} className="p-2.5 flex items-center justify-between gap-3">
                  <div>
                    <span className="font-mono font-medium text-[#12263F]">
                      {tx.id ?? `Payment #${idx + 1}`}
                    </span>
                    {tx.formattedDate && (
                      <span className="text-[11px] text-[#5E718D] ml-2">
                        {tx.formattedDate}
                      </span>
                    )}
                  </div>
                  <span className="font-mono font-semibold text-[#7A5600]">
                    {tx.amountFormatted ?? "Amount not specified"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Refunded or Partially Refunded State
  // ─────────────────────────────────────────────────────────────────────────────
  if (summary.isRefunded || summary.isPartiallyRefunded) {
    const isPartialRefund = summary.isPartiallyRefunded;

    return (
      <section
        aria-label="PayPal Refund Details"
        className="rounded-2xl border border-[#CDC4FF] bg-[#F8F7FF] p-5 shadow-xs space-y-4"
      >
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-[#CDC4FF]/60 pb-3">
          <div className="flex items-center gap-2">
            <span className="p-1 rounded-lg bg-[#F0EEFF] text-[#5B3FD0]">
              <AlertCircle className="w-4 h-4" />
            </span>
            <div>
              <h3 className="font-semibold text-sm text-[#5B3FD0]">
                {isPartialRefund ? "Partial Refund Issued" : "Invoice Refunded"}
              </h3>
              <p className="text-xs text-[#5E718D]">
                Refund processed on PayPal Sandbox
              </p>
            </div>
          </div>
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#5B3FD0] bg-[#F0EEFF] border border-[#CDC4FF] px-2.5 py-1 rounded-full w-fit">
            <span className="w-1.5 h-1.5 rounded-full bg-[#5B3FD0]" />
            <span>{isPartialRefund ? "Partially Refunded" : "Refunded"}</span>
          </span>
        </div>

        {/* Refund Notice */}
        <div className="p-3 rounded-xl bg-[#F0EEFF]/50 border border-[#CDC4FF] text-xs text-[#5B3FD0] leading-relaxed">
          {isPartialRefund
            ? "A partial refund was processed on PayPal Sandbox. Refunded amounts are not treated as retained payments."
            : "This invoice has been fully refunded on PayPal Sandbox. All funds have been returned to the payer."}
        </div>

        {/* Metrics Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
          {/* Total Refunded */}
          <div className="p-3 rounded-xl bg-white border border-[#CDC4FF]/50 space-y-1">
            <span className="text-[11px] font-medium text-[#5E718D] uppercase tracking-wider block">
              Refunded Amount
            </span>
            {summary.refundedAmountFormatted ? (
              <span className="font-mono text-base font-bold text-[#5B3FD0] block tabular-nums">
                {summary.refundedAmountFormatted}
              </span>
            ) : (
              <span className="text-xs text-[#5E718D] italic block">
                Not specified in provider payload
              </span>
            )}
            <span className="text-[10px] text-[#5E718D]">
              Funds returned via PayPal
            </span>
          </div>

          {/* Provider Status */}
          <div className="p-3 rounded-xl bg-white border border-[#CDC4FF]/50 space-y-1">
            <span className="text-[11px] font-medium text-[#5E718D] uppercase tracking-wider block">
              Provider Status
            </span>
            <span className="font-mono text-sm font-bold text-[#12263F] block">
              {summary.rawStatus}
            </span>
            <span className="text-[10px] text-[#5E718D]">
              PayPal record status
            </span>
          </div>
        </div>

        {/* Refund Transactions List */}
        {summary.refundTransactions.length > 0 && (
          <div className="pt-2 border-t border-[#CDC4FF]/60 space-y-2">
            <h4 className="text-xs font-semibold text-[#12263F]">
              Refund Transactions ({summary.refundTransactions.length})
            </h4>
            <div className="divide-y divide-[#EEF2F6] rounded-xl border border-[#CDC4FF]/50 bg-white overflow-hidden text-xs">
              {summary.refundTransactions.map((tx, idx) => (
                <div key={tx.id || idx} className="p-2.5 flex items-center justify-between gap-3">
                  <div>
                    <span className="font-mono font-medium text-[#12263F]">
                      {tx.id ?? `Refund #${idx + 1}`}
                    </span>
                    {tx.formattedDate && (
                      <span className="text-[11px] text-[#5E718D] ml-2">
                        {tx.formattedDate}
                      </span>
                    )}
                    {tx.note && (
                      <p className="text-[11px] text-[#5E718D] italic mt-0.5">
                        Note: {tx.note}
                      </p>
                    )}
                  </div>
                  <span className="font-mono font-semibold text-[#5B3FD0]">
                    {tx.amountFormatted ?? "Amount not specified"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    );
  }

  return null;
}
