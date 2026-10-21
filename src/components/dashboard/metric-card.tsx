import React from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { MetricCardData } from "@/lib/dashboard/metrics";

interface MetricCardProps {
  metric: MetricCardData;
}

export function MetricCard({ metric }: MetricCardProps) {
  // Map badge type to accessible styling
  const badgeColors = {
    teal: "bg-[#E8F5F1] text-[#0C7C61] border-[#A3D9CC]",
    red: "bg-[#FEF3F2] text-[#B42318] border-[#FECDCA]",
    gold: "bg-[#FEF9E7] text-[#7A5600] border-[#F3E0A2]",
    orange: "bg-[#FDF2EB] text-[#B4440B] border-[#F7C4A5]",
    muted: "bg-[#F4F6F8] text-[#5E718D] border-[#E3E8EF]",
  };

  const badgeSymbol = {
    teal: "●",
    red: "●",
    gold: "◷",
    orange: "▲",
    muted: "○",
  };

  const type = metric.badgeType ?? "muted";

  return (
    <Link
      href={metric.href}
      className="group relative flex flex-col justify-between rounded-2xl bg-white border border-[#E3E8EF] p-5 shadow-xs hover:border-[#0C7C61]/50 hover:shadow-md transition-all duration-150 focus-visible:ring-2 focus-visible:ring-[#0C7C61] touch-target"
      aria-label={`${metric.title}: ${metric.formattedAmount}, ${metric.contextText}`}
    >
      {/* Card Header: Title & Status Badge */}
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-semibold tracking-wider uppercase text-[#5E718D]">
          {metric.title}
        </span>

        {metric.badgeText && (
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border ${badgeColors[type]}`}
          >
            <span className="font-mono text-[10px]" aria-hidden="true">
              {badgeSymbol[type]}
            </span>
            <span>{metric.badgeText}</span>
          </span>
        )}
      </div>

      {/* Card Body: Authoritative Amount (Tabular numbers, ISO currency, IBM Plex Mono) */}
      <div className="mt-3">
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono font-semibold text-2xl sm:text-3xl tracking-tight text-[#12263F] tabular-nums">
            {metric.formattedAmount}
          </span>
          <span className="font-mono text-xs text-[#5E718D] font-medium">
            {metric.currency}
          </span>
        </div>
      </div>

      {/* Card Footer: Context details and navigation hint */}
      <div className="mt-4 pt-3 border-t border-[#EEF2F6] flex items-center justify-between text-xs text-[#5E718D]">
        <span>{metric.contextText}</span>
        <span className="inline-flex items-center gap-0.5 font-medium text-[#12263F] group-hover:text-[#0C7C61] transition-colors">
          <span>View</span>
          <ArrowUpRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
        </span>
      </div>
    </Link>
  );
}
