"use client";

import React from "react";
import Link from "next/link";
import {
  CheckCircle2,
  Clock,
  ExternalLink,
  Layers,
  ArrowRight,
} from "lucide-react";
import type {
  InvoiceJourneyTrace,
  InvoiceSelectorOption,
} from "@/lib/services/activity.service";

interface InvoiceJourneyTrackerProps {
  trace: InvoiceJourneyTrace | null;
  selectorOptions: InvoiceSelectorOption[];
  selectedInvoiceId: string | null;
  onSelectInvoice: (invoiceId: string) => void;
  isLoading?: boolean;
}

export function InvoiceJourneyTracker({
  trace,
  selectorOptions,
  selectedInvoiceId,
  onSelectInvoice,
  isLoading = false,
}: InvoiceJourneyTrackerProps) {
  const getBadgeStyle = (badgeLabel?: string) => {
    switch (badgeLabel) {
      case "AI":
        return "bg-[#F0EEFF] text-[#5B3FD0] border-[#CDC4FF]";
      case "You":
        return "bg-[#EDF7F4] text-[#096851] border-[#34C79F]/40";
      case "PayPal":
        return "bg-[#E8F5F1] text-[#0C7C61] border-[#0C7C61]/30";
      default:
        return "bg-[#F4F6F8] text-[#5E718D] border-[#E3E8EF]";
    }
  };

  const getStepIcon = (status: string) => {
    if (status === "completed") {
      return (
        <span className="w-5 h-5 rounded-full bg-[#E8F5F1] text-[#0C7C61] flex items-center justify-center shrink-0 border border-[#0C7C61]/30">
          <CheckCircle2 className="w-3.5 h-3.5" />
        </span>
      );
    }
    if (status === "in_progress") {
      return (
        <span className="w-5 h-5 rounded-full bg-[#FEF9E7] text-[#7A5600] flex items-center justify-center shrink-0 border border-[#F3E0A2] animate-pulse">
          <Clock className="w-3.5 h-3.5" />
        </span>
      );
    }
    return (
      <span className="w-5 h-5 rounded-full bg-[#F4F6F8] text-[#8C9BAE] flex items-center justify-center shrink-0 border border-[#E3E8EF]">
        <span className="w-1.5 h-1.5 rounded-full bg-[#8C9BAE]" />
      </span>
    );
  };

  return (
    <div
      id="invoice-journey-tracker"
      className="rounded-2xl border border-[#E3E8EF] bg-white p-5 shadow-xs space-y-5"
    >
      {/* Header & Selector */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-sm text-[#12263F]">
              Follow one invoice end to end
            </h3>
            <p className="text-xs text-[#5E718D] mt-0.5">
              Trace prompt, AI draft, user approval, and PayPal response
            </p>
          </div>
          <span className="p-1 rounded-lg bg-[#E8F5F1] text-[#0C7C61]">
            <Layers className="w-4 h-4" />
          </span>
        </div>

        {/* Invoice Selector Dropdown */}
        {selectorOptions.length > 0 && (
          <div className="space-y-1">
            <label
              htmlFor="invoice-selector"
              className="block text-[11px] font-medium uppercase tracking-wider text-[#5E718D]"
            >
              Select Invoice to Trace
            </label>
            <select
              id="invoice-selector"
              value={selectedInvoiceId ?? ""}
              onChange={(e) => onSelectInvoice(e.target.value)}
              className="w-full text-xs font-medium py-2 px-3 rounded-xl border border-[#E3E8EF] bg-[#F6F5F1] text-[#12263F] focus:outline-hidden focus:ring-2 focus:ring-[#0C7C61] cursor-pointer"
            >
              {selectorOptions.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.number} · {opt.clientName} ({opt.totalFormatted})
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Trace State */}
      {isLoading ? (
        <div className="py-12 flex flex-col items-center justify-center text-center space-y-2">
          <div className="w-6 h-6 border-2 border-[#0C7C61] border-t-transparent rounded-full animate-spin" />
          <p className="text-xs text-[#5E718D]">Reconstructing invoice journey...</p>
        </div>
      ) : !trace ? (
        <div className="py-8 text-center text-xs text-[#5E718D] border border-dashed border-[#E3E8EF] rounded-xl p-4">
          Select an invoice above or click an activity card to view its 5-step lifecycle.
        </div>
      ) : (
        <div className="space-y-5">
          {/* Active Invoice Overview Banner */}
          <div className="p-3.5 rounded-xl bg-[#F6F5F1] border border-[#E3E8EF] flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs font-bold text-[#12263F]">
                  {trace.invoiceNumber}
                </span>
                <span className="text-[#5E718D] text-xs">·</span>
                <span className="text-xs font-medium text-[#5E718D] truncate">
                  {trace.clientName}
                </span>
              </div>
              <div className="font-mono text-sm font-semibold text-[#0C7C61] mt-0.5">
                {trace.totalFormatted} {trace.currency}
              </div>
            </div>

            <Link
              href={`/invoices/${trace.invoiceId}`}
              className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#0C7C61] hover:underline shrink-0"
            >
              <span>View details</span>
              <ExternalLink className="w-3 h-3" />
            </Link>
          </div>

          {/* 5-Step Stepper (UI Reference Page 15) */}
          <div className="relative pl-6 space-y-4 before:absolute before:left-[9px] before:top-2 before:bottom-2 before:w-[2px] before:bg-[#E3E8EF]">
            {trace.steps.map((step) => (
              <div key={step.stepNumber} className="relative group">
                {/* Node icon */}
                <div className="absolute -left-6 top-0.5">
                  {getStepIcon(step.status)}
                </div>

                {/* Step content */}
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-[#12263F]">
                      {`${step.stepNumber} ${step.title}`}
                    </span>

                    {step.badgeLabel && (
                      <span
                        className={`text-[10px] font-semibold px-1.5 py-0.2 rounded-full border ${getBadgeStyle(
                          step.badgeLabel
                        )}`}
                      >
                        {step.badgeLabel}
                      </span>
                    )}
                  </div>

                  <p className="text-xs text-[#12263F] leading-snug font-medium">
                    {step.summary}
                  </p>

                  {step.details && (
                    <p className="text-[11px] text-[#5E718D] leading-tight">
                      {step.details}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Direct CTA */}
          <div className="pt-2">
            <Link
              href={`/invoices/${trace.invoiceId}`}
              className="w-full inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 rounded-xl border border-[#E3E8EF] bg-white hover:bg-[#F6F5F1] text-[#12263F] text-xs font-semibold shadow-2xs transition-colors touch-target"
            >
              <span>Open Invoice #{trace.invoiceNumber}</span>
              <ArrowRight className="w-3.5 h-3.5 text-[#5E718D]" />
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
