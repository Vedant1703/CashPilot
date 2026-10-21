"use client";

import React, { useState } from "react";
import Link from "next/link";
import { formatMoney } from "@/lib/money";
import { StatusBadge } from "@/components/invoices/status-badge";
import {
  getInvoiceProvenance,
  diffInDays,
  parseDate,
  type InvoiceRecord,
  type GroupedCollections,
} from "@/lib/dashboard/metrics";
import {
  AlertCircle,
  ArrowRight,
} from "lucide-react";

interface KanbanBoardProps {
  collections: GroupedCollections;
  nowUtc?: string;
}

export function KanbanBoard({ collections, nowUtc }: KanbanBoardProps) {
  const now = nowUtc ? new Date(nowUtc) : new Date();
  const [showDragNotice, setShowDragNotice] = useState(false);

  const columnConfig = [
    {
      id: "draft",
      title: "Draft",
      description: "Local or PayPal drafts, not sent",
      invoices: collections.columns.draft,
      badgeColor: "bg-[#F4F6F8] text-[#5E718D] border-[#E3E8EF]",
    },
    {
      id: "awaitingPayment",
      title: "Awaiting Payment",
      description: "Sent via PayPal, awaiting payment",
      invoices: collections.columns.awaitingPayment,
      badgeColor: "bg-[#E8F5F1] text-[#0C7C61] border-[#A3D9CC]",
    },
    {
      id: "dueSoon",
      title: "Due Soon (0–3d)",
      description: "Approaching payment deadline",
      invoices: collections.columns.dueSoon,
      badgeColor: "bg-[#FEF9E7] text-[#7A5600] border-[#F3E0A2]",
    },
    {
      id: "overdue",
      title: "Overdue",
      description: "Due date passed without payment",
      invoices: collections.columns.overdue,
      badgeColor: "bg-[#FEF3F2] text-[#B42318] border-[#FECDCA]",
    },
    {
      id: "paid",
      title: "Paid",
      description: "Verified payment confirmed by PayPal",
      invoices: collections.columns.paid,
      badgeColor: "bg-[#E8F5F1] text-[#0C7C61] border-[#A3D9CC]",
    },
  ];

  const handleCardDragAttempt = (e: React.DragEvent) => {
    e.preventDefault();
    setShowDragNotice(true);
    setTimeout(() => setShowDragNotice(false), 5000);
  };

  return (
    <div className="space-y-6">
      {/* Financial State Protection Alert Banner */}
      {showDragNotice && (
        <div
          role="alert"
          className="p-4 rounded-xl bg-[#FDF2EB] border border-[#F7C4A5] text-[#B4440B] text-xs flex items-center justify-between gap-3 shadow-md animate-in fade-in slide-in-from-top-2"
        >
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span className="font-semibold">
              ▲ Can&apos;t move to Paid by dragging. PayPal reports payment, and CashPilot follows. Refresh to check.
            </span>
          </div>
          <button
            type="button"
            onClick={() => setShowDragNotice(false)}
            className="text-[#B4440B] hover:text-[#12263F] font-bold text-sm px-2 py-1"
          >
            ✕
          </button>
        </div>
      )}

      {/* Main 5-Column Kanban Board */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 items-start">
        {columnConfig.map((col) => {
          const colTotal = col.invoices.reduce(
            (sum, inv) => sum + inv.totalMinorUnits,
            0
          );
          const currency = col.invoices[0]?.currency ?? "USD";

          return (
            <div
              key={col.id}
              className="flex flex-col rounded-2xl bg-[#F6F5F1] border border-[#E3E8EF] p-3 min-h-[420px]"
            >
              {/* Column Header */}
              <div className="pb-3 mb-3 border-b border-[#E3E8EF] px-1">
                <div className="flex items-center justify-between gap-1">
                  <h3 className="font-semibold text-xs tracking-wider uppercase text-[#12263F]">
                    {col.title}
                  </h3>
                  <span
                    className={`font-mono text-xs px-2 py-0.5 rounded-full border ${col.badgeColor} font-semibold tabular-nums`}
                  >
                    {col.invoices.length}
                  </span>
                </div>

                <div className="mt-1 flex items-baseline justify-between text-xs text-[#5E718D]">
                  <span className="text-[11px] truncate">{col.description}</span>
                  <span className="font-mono text-[11px] font-semibold text-[#12263F] tabular-nums shrink-0 ml-1">
                    {formatMoney(colTotal, currency)}
                  </span>
                </div>
              </div>

              {/* Cards Container */}
              <div className="space-y-3 flex-1">
                {col.invoices.length === 0 ? (
                  <div className="h-32 flex flex-col items-center justify-center rounded-xl border border-dashed border-[#E3E8EF] text-center p-3 text-xs text-[#5E718D]">
                    <span>No invoices</span>
                  </div>
                ) : (
                  col.invoices.map((inv) => (
                    <KanbanCard
                      key={inv.id}
                      invoice={inv}
                      now={now}
                      onDragAttempt={handleCardDragAttempt}
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Dedicated Outside the Board Tray: Needs Review & Cancelled */}
      <div className="rounded-2xl bg-white border border-[#E3E8EF] p-5 shadow-xs">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-sm text-[#12263F]">
                Outside the Primary Board
              </h3>
              <span className="text-[11px] font-mono text-[#5E718D] px-2 py-0.5 rounded-full bg-[#F6F5F1] border border-[#E3E8EF]">
                Excluded from Receivables Totals
              </span>
            </div>
            <p className="text-xs text-[#5E718D] mt-0.5">
              Invoices requiring human review or cancelled records are kept visible here but never counted in active receivables.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Needs Review Section */}
          <div className="p-4 rounded-xl bg-[#FDF2EB]/50 border border-[#F7C4A5]">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-[#B4440B] flex items-center gap-1.5">
                <span>▲ Needs Review</span>
                <span className="font-mono text-[11px] px-1.5 py-0.2 rounded-full bg-[#FDF2EB] border border-[#F7C4A5]">
                  {collections.tray.needsReview.length}
                </span>
              </span>
            </div>

            {collections.tray.needsReview.length === 0 ? (
              <p className="text-xs text-[#5E718D] italic py-2">
                No invoices currently require review.
              </p>
            ) : (
              <div className="space-y-2 mt-2">
                {collections.tray.needsReview.map((inv) => (
                  <KanbanCard key={inv.id} invoice={inv} now={now} onDragAttempt={handleCardDragAttempt} />
                ))}
              </div>
            )}
          </div>

          {/* Cancelled Section */}
          <div className="p-4 rounded-xl bg-[#F6F5F1]/80 border border-[#E3E8EF]">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-[#5E718D] flex items-center gap-1.5">
                <span>✕ Cancelled</span>
                <span className="font-mono text-[11px] px-1.5 py-0.2 rounded-full bg-white border border-[#E3E8EF]">
                  {collections.tray.cancelled.length}
                </span>
              </span>
            </div>

            {collections.tray.cancelled.length === 0 ? (
              <p className="text-xs text-[#5E718D] italic py-2">
                No cancelled invoices.
              </p>
            ) : (
              <div className="space-y-2 mt-2">
                {collections.tray.cancelled.map((inv) => (
                  <KanbanCard key={inv.id} invoice={inv} now={now} onDragAttempt={handleCardDragAttempt} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Individual Kanban Card Component
// ─────────────────────────────────────────────────────────────────────────────

interface KanbanCardProps {
  invoice: InvoiceRecord;
  now: Date;
  onDragAttempt: (e: React.DragEvent) => void;
}

function KanbanCard({ invoice, now, onDragAttempt }: KanbanCardProps) {
  const provenance = getInvoiceProvenance(invoice);
  const formattedAmount = formatMoney(invoice.totalMinorUnits, invoice.currency);
  const daysDiff = diffInDays(parseDate(invoice.dueDate), now);

  // Due date descriptive chip
  let dueText = `Due ${new Date(invoice.dueDate).toLocaleDateString([], { month: "short", day: "numeric" })}`;
  let dueColor = "text-[#5E718D]";

  if (daysDiff < 0) {
    dueText = `${Math.abs(daysDiff)}d overdue`;
    dueColor = "text-[#B42318] font-semibold";
  } else if (daysDiff === 0) {
    dueText = "Due today";
    dueColor = "text-[#7A5600] font-semibold";
  } else if (daysDiff <= 3) {
    dueText = `Due in ${daysDiff}d`;
    dueColor = "text-[#7A5600] font-semibold";
  }

  return (
    <div
      draggable
      onDragStart={onDragAttempt}
      className="group relative rounded-xl bg-white border border-[#E3E8EF] p-3.5 shadow-xs hover:border-[#0C7C61]/50 hover:shadow-md transition-all cursor-pointer"
    >
      <Link href={`/invoices/${invoice.id}`} className="block focus:outline-hidden">
        {/* Top: Invoice Identifier & Status Chip */}
        <div className="flex items-center justify-between gap-1.5 mb-2">
          <span className="font-mono text-xs font-semibold text-[#12263F] group-hover:text-[#0C7C61] transition-colors">
            {invoice.number ?? invoice.id.slice(0, 8)}
          </span>

          <StatusBadge status={invoice.cashpilotStatus} size="sm" />
        </div>

        {/* Client & Title */}
        <div className="mb-2">
          <p className="text-xs font-semibold text-[#12263F] truncate">
            {invoice.client.name}
          </p>
          {invoice.title && (
            <p className="text-[11px] text-[#5E718D] truncate mt-0.5">
              {invoice.title}
            </p>
          )}
        </div>

        {/* Amount & Currency (Tabular figures) */}
        <div className="flex items-baseline justify-between pt-2 border-t border-[#EEF2F6]">
          <span className="font-mono text-sm font-semibold tabular-nums text-[#12263F]">
            {formattedAmount}
          </span>

          <span className={`text-[11px] font-mono ${dueColor}`}>
            {dueText}
          </span>
        </div>

        {/* Provenance Tag */}
        <div className="mt-2.5 flex items-center justify-between gap-1 text-[10px]">
          <span
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border ${provenance.badgeClass}`}
            title={`Source: ${provenance.label}`}
          >
            <span className="font-mono" aria-hidden="true">{provenance.symbol}</span>
            <span className="truncate max-w-[130px]">{provenance.label}</span>
          </span>

          <span className="text-[#5E718D] group-hover:text-[#0C7C61] transition-colors inline-flex items-center gap-0.5 font-medium">
            <span>Open</span>
            <ArrowRight className="w-3 h-3 group-hover:translate-x-0.5 transition-transform" />
          </span>
        </div>
      </Link>
    </div>
  );
}
