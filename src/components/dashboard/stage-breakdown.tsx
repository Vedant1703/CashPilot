import React from "react";
import Link from "next/link";
import type { DashboardMetrics } from "@/lib/dashboard/metrics";

interface StageBreakdownProps {
  breakdown: DashboardMetrics["stageBreakdown"];
}

export function StageBreakdown({ breakdown }: StageBreakdownProps) {
  const { stages, totalOutstandingMinorUnits } = breakdown;

  return (
    <div className="rounded-2xl bg-white border border-[#E3E8EF] p-5 sm:p-6 shadow-xs">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
        <div>
          <h3 className="font-semibold text-sm text-[#12263F]">
            Outstanding by Stage
          </h3>
          <p className="text-xs text-[#5E718D] mt-0.5">
            Breakdown of unpaid invoices across collection lifecycles
          </p>
        </div>
        <Link
          href="/collections"
          className="text-xs font-medium text-[#0C7C61] hover:underline self-start sm:self-center"
        >
          View Kanban board →
        </Link>
      </div>

      {/* Progress Bar Container */}
      <div
        className="w-full h-3 rounded-full bg-[#F4F6F8] overflow-hidden flex"
        role="progressbar"
        aria-label="Outstanding receivables distribution by stage"
        aria-valuenow={100}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        {totalOutstandingMinorUnits > 0 ? (
          stages.map((stage) => {
            if (stage.amountMinorUnits === 0) return null;
            const pct = Math.max((stage.amountMinorUnits / totalOutstandingMinorUnits) * 100, 2);
            return (
              <div
                key={stage.key}
                style={{ width: `${pct}%`, backgroundColor: stage.color }}
                className="h-full transition-all duration-300"
                title={`${stage.label}: ${stage.formattedAmount} (${Math.round(pct)}%)`}
              />
            );
          })
        ) : (
          <div className="w-full h-full bg-[#E3E8EF]" title="No outstanding balance" />
        )}
      </div>

      {/* Breakdown Legend Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4">
        {stages.map((stage) => {
          let stageHref = "/collections";
          if (stage.key === "OVERDUE") stageHref = "/collections?stage=overdue";
          if (stage.key === "DUE_SOON") stageHref = "/collections?stage=due_soon";
          if (stage.key === "AWAITING_PAYMENT") stageHref = "/collections?stage=awaiting";

          return (
            <Link
              key={stage.key}
              href={stageHref}
              className="flex items-center justify-between p-3 rounded-xl bg-[#F6F5F1]/60 hover:bg-[#F6F5F1] border border-[#E3E8EF] transition-colors"
            >
              <div className="flex items-center gap-2">
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: stage.color }}
                  aria-hidden="true"
                />
                <span className="text-xs font-medium text-[#12263F]">
                  {stage.label}
                </span>
              </div>

              <div className="flex flex-col items-end">
                <span className="font-mono text-xs font-semibold tabular-nums text-[#12263F]">
                  {stage.formattedAmount}
                </span>
                <span className="text-[10px] text-[#5E718D]">
                  {stage.count} invoice{stage.count === 1 ? "" : "s"}
                </span>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
