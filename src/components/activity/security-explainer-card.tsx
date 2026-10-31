import React from "react";
import { ShieldCheck, Lock, Database } from "lucide-react";

/**
 * Security & Audit Invariants Explainer Card
 *
 * Implements Page 15 "What is recorded" section from UI Design Reference:
 * "Time, who or what acted, the invoice, the outcome and a reference for support.
 * Never passwords, tokens or card details. Entries are never edited, only added to."
 */
export function SecurityExplainerCard() {
  return (
    <div className="rounded-2xl border border-[#E3E8EF] bg-white p-5 shadow-xs space-y-4">
      <div className="flex items-center gap-2 text-[#12263F]">
        <div className="p-1.5 rounded-lg bg-[#E8F5F1] text-[#0C7C61]">
          <ShieldCheck className="w-4 h-4" />
        </div>
        <h3 className="font-semibold text-xs uppercase tracking-wider text-[#12263F]">
          What is recorded
        </h3>
      </div>

      <p className="text-xs text-[#5E718D] leading-relaxed">
        Time, who or what acted, the invoice, the outcome and a reference for support. Never passwords, tokens or card details.
      </p>

      <div className="pt-2 border-t border-[#EEF2F6] space-y-2">
        <div className="flex items-center gap-2 text-[11px] text-[#12263F]">
          <Database className="w-3.5 h-3.5 text-[#0C7C61] shrink-0" />
          <span className="font-medium">Append-only log:</span>
          <span className="text-[#5E718D]">Entries are never edited, only added to</span>
        </div>

        <div className="flex items-center gap-2 text-[11px] text-[#12263F]">
          <Lock className="w-3.5 h-3.5 text-[#5B3FD0] shrink-0" />
          <span className="font-medium">Exact payload hashes:</span>
          <span className="text-[#5E718D]">Approvals locked to SHA-256 versions</span>
        </div>
      </div>
    </div>
  );
}
