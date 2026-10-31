"use client";

import React, { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { formatMoney } from "@/lib/money";
import { StatusBadge } from "@/components/invoices/status-badge";
import type { BatchSyncSummary } from "@/lib/services/invoice.service";
import {
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  ShieldCheck,
  X,
  Clock,
} from "lucide-react";

interface ReconciliationModalProps {
  isOpen: boolean;
  onClose: () => void;
  workspaceId?: string;
  initialSummary?: BatchSyncSummary;
  onReconciliationComplete?: (summary: BatchSyncSummary) => void;
}

type SyncPhase = "asking" | "checking" | "matching" | "saving" | "updating" | "done";

export function ReconciliationModal({
  isOpen,
  onClose,
  workspaceId,
  initialSummary,
  onReconciliationComplete,
}: ReconciliationModalProps) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<BatchSyncSummary | null>(null);
  const [currentPhase, setCurrentPhase] = useState<SyncPhase>("asking");

  const displaySummary = initialSummary ?? summary;

  const startReconciliation = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setCurrentPhase("asking");

    // Phase progression timers for visual transparency
    const t1 = setTimeout(() => setCurrentPhase("checking"), 600);
    const t2 = setTimeout(() => setCurrentPhase("matching"), 1200);
    const t3 = setTimeout(() => setCurrentPhase("saving"), 1800);
    const t4 = setTimeout(() => setCurrentPhase("updating"), 2400);

    try {
      const res = await fetch("/api/invoices/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: workspaceId ? JSON.stringify({ workspaceId }) : undefined,
      });

      const json = await res.json();

      if (!res.ok || !json.success) {
        throw new Error(json.error || "Failed to reconcile with PayPal Sandbox");
      }

      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
      setCurrentPhase("done");
      setSummary(json.data);
      if (onReconciliationComplete) {
        onReconciliationComplete(json.data);
      }
    } catch (err) {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
      setError(err instanceof Error ? err.message : "Reconciliation error occurred");
    } finally {
      setIsLoading(false);
    }
  }, [workspaceId, onReconciliationComplete]);

  useEffect(() => {
    if (!isOpen || initialSummary) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) {
        void startReconciliation();
      }
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isOpen, initialSummary, startReconciliation]);

  if (!isOpen) return null;

  const handleApplyAndClose = () => {
    onClose();
    router.refresh();
  };

  const steps = [
    { id: "asking", label: "1 Ask PayPal", desc: "Query GET /v2/invoicing/invoices" },
    { id: "checking", label: "2 Check answer", desc: "Verify status & error codes" },
    { id: "matching", label: "3 Match stage", desc: "Map provider status + due date" },
    { id: "saving", label: "4 Save & log", desc: "Append-only audit trail" },
    { id: "updating", label: "5 Update board", desc: "Compute column metric deltas" },
  ];

  const getStepStatus = (stepId: string) => {
    if (displaySummary || currentPhase === "done") return "completed";
    const phaseOrder = ["asking", "checking", "matching", "saving", "updating"];
    const currentIndex = phaseOrder.indexOf(currentPhase);
    const stepIndex = phaseOrder.indexOf(stepId);

    if (stepIndex < currentIndex) return "completed";
    if (stepIndex === currentIndex) return "active";
    return "pending";
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="reconciliation-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#12263F]/60 backdrop-blur-xs animate-in fade-in duration-200"
    >
      <div className="relative w-full max-w-3xl max-h-[90vh] flex flex-col rounded-2xl bg-white border border-[#E3E8EF] shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="p-5 sm:p-6 border-b border-[#E3E8EF] flex items-start justify-between gap-4 bg-[#F6F5F1]/50">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-xl bg-[#E8F5F1] text-[#0C7C61] border border-[#A3D9CC] shrink-0 mt-0.5">
              <RefreshCw className={`w-5 h-5 ${isLoading ? "animate-spin" : ""}`} />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <span className="text-[11px] font-mono font-semibold px-2 py-0.5 rounded-full bg-[#E8F5F1] text-[#0C7C61] border border-[#A3D9CC]">
                  ● Verified by PayPal Sandbox
                </span>
                <span className="text-xs text-[#5E718D]">·</span>
                <span className="text-xs font-mono text-[#5E718D]">UI Reference Page 14</span>
              </div>
              <h2
                id="reconciliation-modal-title"
                className="font-headline font-bold text-xl sm:text-2xl text-[#12263F]"
              >
                Reconcile Receivables with PayPal
              </h2>
              <p className="text-xs text-[#5E718D] mt-1 leading-relaxed">
                Queries PayPal Sandbox to verify latest provider statuses, map lifecycle stages, and reconcile your Kanban board.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#5E718D] hover:text-[#12263F] hover:bg-[#F6F5F1] transition-colors"
            aria-label="Close reconciliation modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable Content Body */}
        <div className="flex-1 overflow-y-auto p-5 sm:p-6 space-y-6">
          {/* 5-Step Process Stepper */}
          <section aria-label="Reconciliation Progress" className="rounded-xl bg-[#F6F5F1] border border-[#E3E8EF] p-3 sm:p-4">
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 sm:gap-3">
              {steps.map((st) => {
                const status = getStepStatus(st.id);
                return (
                  <div
                    key={st.id}
                    className={`p-2.5 rounded-lg border transition-all text-center flex flex-col justify-between ${
                      status === "completed"
                        ? "bg-[#E8F5F1] border-[#A3D9CC] text-[#0C7C61]"
                        : status === "active"
                        ? "bg-white border-[#0C7C61] shadow-xs ring-2 ring-[#0C7C61]/20"
                        : "bg-white/60 border-[#E3E8EF] text-[#8A9BA8]"
                    }`}
                  >
                    <div className="flex items-center justify-center gap-1 mb-1">
                      {status === "completed" ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-[#0C7C61]" />
                      ) : status === "active" ? (
                        <RefreshCw className="w-3.5 h-3.5 text-[#0C7C61] animate-spin" />
                      ) : (
                        <Clock className="w-3.5 h-3.5 text-[#8A9BA8]" />
                      )}
                      <span className="font-semibold text-xs leading-none">
                        {st.label}
                      </span>
                    </div>
                    <span className="text-[10px] text-[#5E718D] leading-tight truncate">
                      {st.desc}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Loading Indicator State */}
          {isLoading && (
            <div className="py-8 text-center space-y-3">
              <RefreshCw className="w-8 h-8 text-[#0C7C61] animate-spin mx-auto" />
              <p className="text-sm font-semibold text-[#12263F]">
                Connecting to PayPal Sandbox API...
              </p>
              <p className="text-xs text-[#5E718D] max-w-sm mx-auto">
                Validating provider status for all linked invoices and recording audit evidence.
              </p>
            </div>
          )}

          {/* Error Alert */}
          {error && (
            <div className="p-4 rounded-xl bg-[#FEF3F2] border border-[#FECDCA] text-[#B42318] space-y-2">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 shrink-0" />
                <h3 className="font-semibold text-sm">Reconciliation Encountered an Error</h3>
              </div>
              <p className="text-xs text-[#5E718D]">{error}</p>
              <button
                type="button"
                onClick={startReconciliation}
                className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#B42318] text-white text-xs font-semibold hover:bg-[#912015] transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Try again</span>
              </button>
            </div>
          )}

          {/* Summary & Before/After Metrics (when complete) */}
          {displaySummary && !isLoading && (
            <div className="space-y-6">
              {/* Metric Delta Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="p-4 rounded-xl bg-[#F6F5F1] border border-[#E3E8EF] space-y-1">
                  <span className="text-xs text-[#5E718D] font-medium">Invoices Checked</span>
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-xl font-bold tabular-nums text-[#12263F]">
                      {displaySummary.totalPaypalInvoicesQueried}
                    </span>
                    <span className="text-xs text-[#5E718D]">
                      of {displaySummary.totalInvoicesScanned} total
                    </span>
                  </div>
                </div>

                <div className="p-4 rounded-xl bg-[#F6F5F1] border border-[#E3E8EF] space-y-1">
                  <span className="text-xs text-[#5E718D] font-medium">Status Updates</span>
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-xl font-bold tabular-nums text-[#0C7C61]">
                      {displaySummary.changedCount}
                    </span>
                    <span className="text-xs text-[#5E718D]">
                      {displaySummary.changedCount === 1 ? "card moved" : "cards moved"}
                    </span>
                  </div>
                </div>

                <div className="p-4 rounded-xl bg-[#F6F5F1] border border-[#E3E8EF] space-y-1">
                  <span className="text-xs text-[#5E718D] font-medium">Outstanding Delta</span>
                  <div className="flex items-baseline gap-1.5">
                    <span className="font-mono text-base font-semibold tabular-nums text-[#12263F]">
                      {formatMoney(displaySummary.beforeOutstandingMinorUnits, displaySummary.currency)}
                    </span>
                    <ArrowRight className="w-3.5 h-3.5 text-[#5E718D]" />
                    <span className="font-mono text-base font-bold tabular-nums text-[#0C7C61]">
                      {formatMoney(displaySummary.afterOutstandingMinorUnits, displaySummary.currency)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Before and After Kanban Column Counts */}
              <div className="rounded-xl border border-[#E3E8EF] bg-white p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="font-semibold text-xs text-[#12263F] uppercase tracking-wider">
                    Board Column Changes
                  </h4>
                  <span className="text-[11px] font-mono text-[#5E718D]">
                    Before → After
                  </span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 text-xs">
                  {[
                    { label: "Draft", before: displaySummary.beforeStages.draft, after: displaySummary.afterStages.draft },
                    { label: "Awaiting", before: displaySummary.beforeStages.awaitingPayment, after: displaySummary.afterStages.awaitingPayment },
                    { label: "Due Soon", before: displaySummary.beforeStages.dueSoon, after: displaySummary.afterStages.dueSoon },
                    { label: "Overdue", before: displaySummary.beforeStages.overdue, after: displaySummary.afterStages.overdue },
                    { label: "Paid", before: displaySummary.beforeStages.paid, after: displaySummary.afterStages.paid },
                    { label: "Review", before: displaySummary.beforeStages.needsReview, after: displaySummary.afterStages.needsReview },
                  ].map((col) => {
                    const diff = col.after - col.before;
                    const changed = diff !== 0;

                    return (
                      <div
                        key={col.label}
                        className={`p-2.5 rounded-lg border text-center transition-colors ${
                          changed
                            ? "bg-[#E8F5F1]/60 border-[#0C7C61] shadow-2xs"
                            : "bg-[#F6F5F1]/60 border-[#E3E8EF]"
                        }`}
                      >
                        <span className="block text-[11px] text-[#5E718D] font-medium truncate">
                          {col.label}
                        </span>
                        <div className="font-mono font-bold text-sm mt-0.5 text-[#12263F] tabular-nums">
                          {col.before} → {col.after}
                        </div>
                        {changed && (
                          <span
                            className={`text-[10px] font-mono font-semibold px-1 rounded ${
                              diff > 0 ? "text-[#0C7C61] bg-[#E8F5F1]" : "text-[#B4440B] bg-[#FDF2EB]"
                            }`}
                          >
                            {diff > 0 ? `+${diff}` : diff}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Itemized Reconciliation Table */}
              <div className="space-y-2">
                <h4 className="font-semibold text-xs text-[#12263F] uppercase tracking-wider">
                  Reconciliation Details ({displaySummary.items.length})
                </h4>

                <div className="rounded-xl border border-[#E3E8EF] overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-[#F6F5F1] border-b border-[#E3E8EF] text-[#5E718D] font-semibold">
                        <tr>
                          <th className="py-2.5 px-3">Invoice</th>
                          <th className="py-2.5 px-3">Amount</th>
                          <th className="py-2.5 px-3">PayPal Status</th>
                          <th className="py-2.5 px-3">CashPilot Stage</th>
                          <th className="py-2.5 px-3">Result / Evidence</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#EEF2F6] font-medium text-[#12263F]">
                        {displaySummary.items.map((item) => (
                          <tr
                            key={item.invoiceId}
                            className={`hover:bg-[#F6F5F1]/50 transition-colors ${
                              item.statusChanged ? "bg-[#E8F5F1]/20" : ""
                            }`}
                          >
                            <td className="py-3 px-3">
                              <span className="font-mono font-semibold text-xs block text-[#12263F]">
                                {item.number ?? item.invoiceId.slice(0, 8)}
                              </span>
                              <span className="text-[11px] text-[#5E718D] truncate block max-w-[140px]">
                                {item.clientName}
                              </span>
                            </td>

                            <td className="py-3 px-3 font-mono font-semibold tabular-nums whitespace-nowrap">
                              {formatMoney(item.totalMinorUnits, item.currency)}
                            </td>

                            <td className="py-3 px-3 whitespace-nowrap">
                              {item.hasPaypalInvoice ? (
                                <span
                                  className={`inline-flex items-center gap-1 font-mono text-[11px] px-2 py-0.5 rounded-full border ${
                                    item.currentPaypalStatus === "PAID"
                                      ? "bg-[#E8F5F1] text-[#0C7C61] border-[#A3D9CC]"
                                      : item.currentPaypalStatus === "SENT"
                                      ? "bg-[#E8F5F1] text-[#0C7C61] border-[#A3D9CC]"
                                      : item.currentPaypalStatus === "CANCELLED"
                                      ? "bg-[#F4F6F8] text-[#8A9BA8] border-[#E3E8EF]"
                                      : item.isStale
                                      ? "bg-[#FEF3F2] text-[#B42318] border-[#FECDCA]"
                                      : "bg-[#F4F6F8] text-[#5E718D] border-[#E3E8EF]"
                                  }`}
                                >
                                  <span>{item.isStale ? "▲" : "●"}</span>
                                  <span>{item.currentPaypalStatus ?? "DRAFT"}</span>
                                </span>
                              ) : (
                                <span className="font-mono text-[11px] text-[#8A9BA8] italic">
                                  Not linked
                                </span>
                              )}
                            </td>

                            <td className="py-3 px-3 whitespace-nowrap">
                              <StatusBadge status={item.currentCashpilotStatus} size="sm" />
                            </td>

                            <td className="py-3 px-3 text-[11px] leading-relaxed">
                              {item.statusChanged ? (
                                <span className="text-[#0C7C61] font-semibold flex items-center gap-1">
                                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                                  <span>{item.message}</span>
                                </span>
                              ) : item.isStale ? (
                                <span className="text-[#B42318] flex items-center gap-1">
                                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                                  <span>{item.message}</span>
                                </span>
                              ) : (
                                <span className="text-[#5E718D]">{item.message}</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              {/* Financial Truth & Stale Preservation Guarantee */}
              <div className="p-3.5 rounded-xl bg-[#FEF9E7] border border-[#F3E0A2] text-[#7A5600] text-xs flex items-start gap-2.5">
                <ShieldCheck className="w-4 h-4 text-[#7A5600] shrink-0 mt-0.5" />
                <p className="leading-relaxed">
                  <span className="font-semibold">Financial Integrity Invariant:</span> Only verified provider evidence sets status to <span className="font-semibold font-mono">PAID</span>. Unreachable or timed-out invoices preserve their last known valid state as stale and are never assumed Paid.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="p-4 sm:p-5 border-t border-[#E3E8EF] bg-[#F6F5F1] flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-[#5E718D]">
            {displaySummary ? `Reconciled at ${new Date(displaySummary.syncedAt).toLocaleTimeString()}` : "Ready to synchronize"}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isLoading}
              className="px-4 py-2.5 rounded-xl border border-[#E3E8EF] bg-white hover:bg-[#F6F5F1] text-xs font-semibold text-[#12263F] transition-colors touch-target disabled:opacity-50"
            >
              Close
            </button>

            {displaySummary ? (
              <button
                type="button"
                onClick={handleApplyAndClose}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-[#0C7C61] hover:bg-[#096851] text-white text-xs font-semibold shadow-xs transition-colors touch-target"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>Apply & Update Board</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={startReconciliation}
                disabled={isLoading}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-[#0C7C61] hover:bg-[#096851] text-white text-xs font-semibold shadow-xs transition-colors touch-target disabled:opacity-50"
              >
                <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
                <span>{isLoading ? "Reconciling..." : "Run Reconciliation"}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
