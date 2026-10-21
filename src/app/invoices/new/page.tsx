import React from "react";
import Link from "next/link";
import { AppHeader } from "@/components/layout/app-header";
import { MobileNav } from "@/components/layout/mobile-nav";
import { NaviAvatar } from "@/components/navi/navi-avatar";
import { ArrowLeft, Sparkles, ArrowRight } from "lucide-react";

export default function NewInvoicePlaceholderPage() {
  return (
    <div className="min-h-screen flex flex-col bg-[#F6F5F1] text-[#12263F] pb-16 md:pb-8">
      <AppHeader />

      <main className="flex-1 max-w-3xl w-full mx-auto px-4 sm:px-6 py-12 flex flex-col items-center justify-center text-center">
        <div className="w-full rounded-2xl bg-white border border-[#E3E8EF] p-8 shadow-xs space-y-6">
          <NaviAvatar state="thinking" size={64} className="mx-auto" />

          <div className="space-y-2">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-[#F0EEFF] text-[#5B3FD0] border border-[#CDC4FF]">
              <Sparkles className="w-3.5 h-3.5" />
              <span>Invoice Studio · Queued for Next Task</span>
            </span>

            <h1 className="font-headline font-bold text-2xl sm:text-3xl text-[#12263F]">
              AI Invoice Drafting Studio
            </h1>

            <p className="text-sm text-[#5E718D] max-w-lg mx-auto leading-relaxed">
              The natural language invoice drafting journey (Describe → Review draft → Approve → PayPal Sandbox confirmation) is scheduled in subsequent tasks per the implementation roadmap.
            </p>
          </div>

          <div className="pt-4 border-t border-[#EEF2F6] flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl border border-[#E3E8EF] text-xs font-semibold text-[#12263F] hover:bg-[#F6F5F1] transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Back to Dashboard</span>
            </Link>

            <Link
              href="/collections"
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-[#0C7C61] hover:bg-[#096851] text-xs font-semibold text-white shadow-xs transition-colors"
            >
              <span>Explore Collections Board</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        </div>
      </main>

      <MobileNav />
    </div>
  );
}
