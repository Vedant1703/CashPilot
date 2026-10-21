"use client";

import React, { useState } from "react";
import { NaviAvatar } from "@/components/navi/navi-avatar";
import { Sparkles, ArrowRight, ShieldCheck, FileEdit, AlertCircle } from "lucide-react";
import { ExtractionResponseData } from "./types";

interface DescribeStepProps {
  onDraftGenerated: (prompt: string, extractionData: ExtractionResponseData) => void;
  onManualDraftRequested: () => void;
  isLoading: boolean;
  error?: string | null;
}

export function DescribeStep({
  onDraftGenerated,
  onManualDraftRequested,
  isLoading,
  error,
}: DescribeStepProps) {
  const [prompt, setPrompt] = useState("");

  const examplePrompts = [
    "Bill Acme Corp for 10 hours of system design consulting at $150 per hour, net 14",
    "Bill Jane Smith $2,500 for Brand Strategy Consulting, due in 7 days",
    "Bill TechStart $1,250 for sprint 3 frontend development, 10% tax, due Nov 4, 2026",
  ];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || isLoading) return;

    try {
      const res = await fetch("/api/invoices/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: prompt.trim() }),
      });

      const json = await res.json();
      if (res.ok && json.success) {
        onDraftGenerated(prompt.trim(), json.data);
      } else {
        alert(json.error || "Failed to extract invoice from description.");
      }
    } catch {
      alert("Network error while connecting to extraction service.");
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-8 animate-in fade-in duration-200">
      {/* Step Heading */}
      <div className="text-center space-y-2">
        <NaviAvatar state={isLoading ? "thinking" : "helping"} size={56} className="mx-auto" />
        <h1 className="font-headline font-bold text-2xl sm:text-3xl text-[#12263F] tracking-tight">
          What are we billing today?
        </h1>
        <p className="text-sm text-[#5E718D] max-w-lg mx-auto leading-relaxed">
          Describe your invoice in your own words. Navi extracts the line items, rates, and client details so you can review them before anything is created.
        </p>
      </div>

      {/* Main Input Form */}
      <form onSubmit={handleSubmit} className="rounded-2xl bg-white border border-[#E3E8EF] p-5 sm:p-6 shadow-xs space-y-4">
        {error && (
          <div className="p-3.5 rounded-xl bg-[#FEF3F2] border border-[#FECDCA] text-[#B42318] text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="space-y-1.5">
          <label htmlFor="invoice-prompt" className="block text-xs font-semibold text-[#12263F]">
            Invoice Description
          </label>
          <textarea
            id="invoice-prompt"
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={isLoading}
            placeholder='e.g., "Bill Acme Corp for 10 hours of system design consulting at $150 per hour, net 14, with 10% tax"'
            className="w-full p-3.5 rounded-xl border border-[#E3E8EF] text-sm focus:outline-hidden focus:border-[#5B3FD0] focus:ring-2 focus:ring-[#5B3FD0]/20 bg-[#F6F5F1]/30 placeholder:text-[#8A9BA8] disabled:opacity-60 leading-relaxed"
            required
          />
        </div>

        {/* Quick Example Chips */}
        <div className="space-y-2 pt-1">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[#5E718D]">
            Try an example prompt:
          </span>
          <div className="flex flex-wrap gap-2">
            {examplePrompts.map((ex, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => setPrompt(ex)}
                disabled={isLoading}
                className="text-left text-xs px-3 py-1.5 rounded-xl bg-[#F6F5F1] hover:bg-[#EEF2F6] text-[#12263F] border border-[#E3E8EF] transition-colors disabled:opacity-50 touch-target"
              >
                &ldquo;{ex}&rdquo;
              </button>
            ))}
          </div>
        </div>

        {/* Action Button & Fallback */}
        <div className="pt-4 border-t border-[#EEF2F6] flex flex-col sm:flex-row items-center justify-between gap-3">
          <button
            type="button"
            onClick={onManualDraftRequested}
            disabled={isLoading}
            className="inline-flex items-center gap-1.5 text-xs text-[#5E718D] hover:text-[#12263F] font-medium touch-target"
          >
            <FileEdit className="w-3.5 h-3.5" />
            <span>Prefer a blank form? Draft manually</span>
          </button>

          <button
            type="submit"
            disabled={!prompt.trim() || isLoading}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-[#5B3FD0] hover:bg-[#4B32B3] text-white text-xs font-semibold shadow-xs transition-colors disabled:opacity-50 touch-target focus-visible:ring-2 focus-visible:ring-[#5B3FD0]"
          >
            {isLoading ? (
              <>
                <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                <span>Reading your request...</span>
              </>
            ) : (
              <>
                <Sparkles className="w-3.5 h-3.5" />
                <span>Draft with Navi</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </>
            )}
          </button>
        </div>
      </form>

      {/* AI Boundaries & Trust Callout (Design reference page 8) */}
      <div className="rounded-2xl bg-white border border-[#E3E8EF] p-5 shadow-xs flex items-start gap-3.5 text-xs text-[#5E718D]">
        <ShieldCheck className="w-5 h-5 text-[#0C7C61] shrink-0 mt-0.5" />
        <div className="space-y-1">
          <p className="font-semibold text-[#12263F]">How CashPilot handles AI drafting</p>
          <ul className="list-disc pl-4 space-y-1 leading-relaxed">
            <li>Navi proposes client, line items, quantities, and rates based on your description.</li>
            <li>Missing facts (like email or dates) are flagged, never guessed or fabricated.</li>
            <li>Authoritative totals are calculated deterministically by server software, never by the AI model.</li>
            <li>Nothing is sent to PayPal until you review and explicitly approve the exact version.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
