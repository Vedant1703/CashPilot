import React from "react";
import Link from "next/link";
import { NaviAvatar } from "@/components/navi/navi-avatar";
import { ArrowRight, ShieldCheck } from "lucide-react";

interface NaviGreetingProps {
  headline: string;
  body: string;
  actionRequiredCount: number;
  primaryActionLabel?: string;
  primaryActionHref?: string;
}

export function NaviGreeting({
  headline,
  body,
  actionRequiredCount,
  primaryActionLabel,
  primaryActionHref,
}: NaviGreetingProps) {
  const naviState = actionRequiredCount > 0 ? "helping" : "idle";

  return (
    <section
      aria-label="Navi AI Assistant Overview"
      className="relative overflow-hidden rounded-2xl bg-white border border-[#E3E8EF] p-5 sm:p-6 shadow-xs"
    >
      {/* Decorative subtle background tint */}
      <div className="absolute top-0 right-0 w-64 h-64 bg-[#F0EEFF]/50 rounded-full blur-3xl pointer-events-none -mr-20 -mt-20" />

      <div className="relative flex flex-col sm:flex-row items-start sm:items-center justify-between gap-5">
        <div className="flex items-start gap-4">
          {/* Navi Avatar (Strict placement: helper callout) */}
          <NaviAvatar state={naviState} size={48} showStatusIndicator={true} />

          <div className="space-y-1.5 max-w-2xl">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-[#F0EEFF] text-[#5B3FD0] border border-[#CDC4FF]">
                <span>✦</span>
                <span>Navi Copilot</span>
              </span>
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[#5E718D]">
                <ShieldCheck className="w-3.5 h-3.5 text-[#0C7C61]" />
                <span>Nothing is sent until you approve</span>
              </span>
            </div>

            <h2 className="font-headline font-semibold text-xl sm:text-2xl text-[#12263F] leading-snug">
              {headline}
            </h2>

            <p className="text-sm text-[#5E718D] leading-relaxed">
              {body}
            </p>
          </div>
        </div>

        {primaryActionLabel && primaryActionHref && (
          <div className="shrink-0 self-stretch sm:self-center">
            <Link
              href={primaryActionHref}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[#12263F] hover:bg-[#1A365D] text-white text-xs font-semibold shadow-xs transition-colors touch-target focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[#12263F]"
            >
              <span>{primaryActionLabel}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        )}
      </div>
    </section>
  );
}
