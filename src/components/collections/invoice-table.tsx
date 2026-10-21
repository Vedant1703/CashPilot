"use client";

import React, { useState, useMemo } from "react";
import Link from "next/link";
import { formatMoney } from "@/lib/money";
import { StatusBadge } from "@/components/invoices/status-badge";
import {
  getInvoiceProvenance,
  diffInDays,
  parseDate,
  type InvoiceRecord,
} from "@/lib/dashboard/metrics";
import { CashPilotStatus } from "@prisma/client";
import { Search, ArrowRight, ArrowUpDown } from "lucide-react";

interface InvoiceTableProps {
  invoices: InvoiceRecord[];
  initialFilter?: string;
  nowUtc?: string;
}

export function InvoiceTable({
  invoices,
  initialFilter = "ALL",
  nowUtc,
}: InvoiceTableProps) {
  const now = useMemo(() => (nowUtc ? new Date(nowUtc) : new Date()), [nowUtc]);
  const [filter, setFilter] = useState<string>(initialFilter);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortField, setSortField] = useState<"dueDate" | "amount" | "number">("dueDate");
  const [sortAsc, setSortAsc] = useState<boolean>(true);

  // Filter tabs config
  const tabs = [
    { key: "ALL", label: "All" },
    { key: "DRAFT", label: "Draft" },
    { key: "AWAITING_PAYMENT", label: "Awaiting" },
    { key: "DUE_SOON", label: "Due Soon" },
    { key: "OVERDUE", label: "Overdue" },
    { key: "PAID", label: "Paid" },
    { key: "NEEDS_REVIEW", label: "Needs Review" },
  ];

  // Filter and sort invoices
  const filteredInvoices = useMemo(() => {
    return invoices
      .filter((inv) => {
        // Tab filtering
        if (filter !== "ALL") {
          if (filter === "DUE_SOON") {
            const days = diffInDays(parseDate(inv.dueDate), now);
            const isDueSoon =
              (days >= 0 && days <= 3 && inv.cashpilotStatus !== CashPilotStatus.PAID) ||
              inv.cashpilotStatus === CashPilotStatus.DUE_SOON;
            if (!isDueSoon) return false;
          } else if (filter === "OVERDUE") {
            const days = diffInDays(parseDate(inv.dueDate), now);
            const isOverdue =
              (days < 0 && inv.cashpilotStatus !== CashPilotStatus.PAID) ||
              inv.cashpilotStatus === CashPilotStatus.OVERDUE;
            if (!isOverdue) return false;
          } else if (filter === "AWAITING_PAYMENT") {
            if (inv.cashpilotStatus !== CashPilotStatus.AWAITING_PAYMENT) return false;
          } else if (inv.cashpilotStatus !== filter) {
            return false;
          }
        }

        // Search filtering
        if (searchQuery.trim().length > 0) {
          const q = searchQuery.toLowerCase();
          const matchNumber = inv.number?.toLowerCase().includes(q) ?? false;
          const matchClient = inv.client.name.toLowerCase().includes(q);
          const matchTitle = inv.title?.toLowerCase().includes(q) ?? false;
          const matchEmail = inv.client.email.toLowerCase().includes(q);
          if (!matchNumber && !matchClient && !matchTitle && !matchEmail) return false;
        }

        return true;
      })
      .sort((a, b) => {
        if (sortField === "amount") {
          return sortAsc
            ? a.totalMinorUnits - b.totalMinorUnits
            : b.totalMinorUnits - a.totalMinorUnits;
        }
        if (sortField === "number") {
          const numA = a.number ?? a.id;
          const numB = b.number ?? b.id;
          return sortAsc ? numA.localeCompare(numB) : numB.localeCompare(numA);
        }
        // Default: due date
        const dateA = parseDate(a.dueDate).getTime();
        const dateB = parseDate(b.dueDate).getTime();
        return sortAsc ? dateA - dateB : dateB - dateA;
      });
  }, [invoices, filter, searchQuery, sortField, sortAsc, now]);

  const toggleSort = (field: "dueDate" | "amount" | "number") => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(true);
    }
  };

  return (
    <div className="rounded-2xl bg-white border border-[#E3E8EF] shadow-xs overflow-hidden">
      {/* Top Filter and Search Bar */}
      <div className="p-4 sm:p-5 border-b border-[#E3E8EF] flex flex-col md:flex-row md:items-center justify-between gap-4">
        {/* Filter Tabs */}
        <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Filter Invoices by Status">
          {tabs.map((tab) => {
            const count = invoices.filter((inv) => {
              if (tab.key === "ALL") return true;
              if (tab.key === "DUE_SOON") {
                const days = diffInDays(parseDate(inv.dueDate), now);
                return (
                  (days >= 0 && days <= 3 && inv.cashpilotStatus !== CashPilotStatus.PAID) ||
                  inv.cashpilotStatus === CashPilotStatus.DUE_SOON
                );
              }
              if (tab.key === "OVERDUE") {
                const days = diffInDays(parseDate(inv.dueDate), now);
                return (
                  (days < 0 && inv.cashpilotStatus !== CashPilotStatus.PAID) ||
                  inv.cashpilotStatus === CashPilotStatus.OVERDUE
                );
              }
              return inv.cashpilotStatus === tab.key;
            }).length;

            const isActive = filter === tab.key;

            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setFilter(tab.key)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-colors touch-target ${
                  isActive
                    ? "bg-[#12263F] text-white font-semibold"
                    : "bg-[#F6F5F1] text-[#5E718D] hover:text-[#12263F] hover:bg-[#EEF2F6]"
                }`}
              >
                <span>{tab.label}</span>
                <span
                  className={`text-[10px] font-mono px-1.5 py-0.2 rounded-full ${
                    isActive ? "bg-white/20 text-white" : "bg-white text-[#5E718D]"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Search Input */}
        <div className="relative w-full md:w-64">
          <Search className="w-4 h-4 text-[#5E718D] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search invoice or client..."
            className="w-full pl-9 pr-3 py-2 rounded-xl border border-[#E3E8EF] text-xs focus:outline-hidden focus:border-[#0C7C61] focus:ring-1 focus:ring-[#0C7C61] bg-[#F6F5F1]/50 placeholder:text-[#8A9BA8]"
            aria-label="Search invoices"
          />
        </div>
      </div>

      {/* Accessible Responsive Table Wrapper (modern-web-guidance) */}
      <div
        tabIndex={0}
        role="region"
        aria-labelledby="invoices-table-caption"
        className="overflow-x-auto max-w-full"
      >
        <table className="w-full text-left border-collapse border-spacing-0">
          <caption id="invoices-table-caption" className="sr-only">
            Authoritative Invoices Listing and Operational Metadata
          </caption>

          <thead className="bg-[#F6F5F1] border-b border-[#E3E8EF] sticky top-0 z-10 text-[11px] font-semibold text-[#5E718D] uppercase tracking-wider">
            <tr>
              <th scope="col" className="py-3 px-4 sm:px-6">
                <button
                  type="button"
                  onClick={() => toggleSort("number")}
                  className="inline-flex items-center gap-1 hover:text-[#12263F]"
                >
                  <span>Invoice</span>
                  <ArrowUpDown className="w-3 h-3" />
                </button>
              </th>
              <th scope="col" className="py-3 px-4 sm:px-6">
                Client
              </th>
              <th scope="col" className="py-3 px-4 sm:px-6">
                <button
                  type="button"
                  onClick={() => toggleSort("amount")}
                  className="inline-flex items-center gap-1 hover:text-[#12263F]"
                >
                  <span>Amount</span>
                  <ArrowUpDown className="w-3 h-3" />
                </button>
              </th>
              <th scope="col" className="py-3 px-4 sm:px-6">
                <button
                  type="button"
                  onClick={() => toggleSort("dueDate")}
                  className="inline-flex items-center gap-1 hover:text-[#12263F]"
                >
                  <span>Due Date</span>
                  <ArrowUpDown className="w-3 h-3" />
                </button>
              </th>
              <th scope="col" className="py-3 px-4 sm:px-6">
                Status
              </th>
              <th scope="col" className="py-3 px-4 sm:px-6">
                Source / Provenance
              </th>
              <th scope="col" className="py-3 px-4 sm:px-6 text-right">
                Action
              </th>
            </tr>
          </thead>

          <tbody className="divide-y divide-[#EEF2F6] text-xs">
            {filteredInvoices.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-12 text-center text-xs text-[#5E718D]">
                  No invoices matched your filter criteria.
                </td>
              </tr>
            ) : (
              filteredInvoices.map((inv) => {
                const provenance = getInvoiceProvenance(inv);
                const daysDiff = diffInDays(parseDate(inv.dueDate), now);

                let dueLabel = new Date(inv.dueDate).toLocaleDateString([], {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                });
                let dueClass = "text-[#5E718D]";

                if (daysDiff < 0 && inv.cashpilotStatus !== CashPilotStatus.PAID) {
                  dueLabel = `${Math.abs(daysDiff)}d overdue`;
                  dueClass = "text-[#B42318] font-semibold";
                } else if (daysDiff <= 3 && daysDiff >= 0 && inv.cashpilotStatus !== CashPilotStatus.PAID) {
                  dueLabel = `Due in ${daysDiff}d`;
                  dueClass = "text-[#7A5600] font-semibold";
                }

                return (
                  <tr
                    key={inv.id}
                    className="hover:bg-[#F6F5F1]/50 transition-colors group"
                  >
                    {/* Invoice ID / Number */}
                    <td className="py-3.5 px-4 sm:px-6 font-mono font-semibold text-[#12263F]">
                      <Link
                        href={`/invoices/${inv.id}`}
                        className="hover:text-[#0C7C61] hover:underline"
                      >
                        {inv.number ?? inv.id.slice(0, 10)}
                      </Link>
                    </td>

                    {/* Client Name & Email */}
                    <td className="py-3.5 px-4 sm:px-6">
                      <div className="font-medium text-[#12263F]">
                        {inv.client.name}
                      </div>
                      <div className="text-[11px] text-[#5E718D] truncate max-w-[180px]">
                        {inv.client.email}
                      </div>
                    </td>

                    {/* Amount (Tabular figures, ISO currency) */}
                    <td className="py-3.5 px-4 sm:px-6 font-mono font-semibold tabular-nums text-[#12263F]">
                      {formatMoney(inv.totalMinorUnits, inv.currency)}
                    </td>

                    {/* Due Date */}
                    <td className={`py-3.5 px-4 sm:px-6 font-mono text-xs ${dueClass}`}>
                      {dueLabel}
                    </td>

                    {/* Status Badge */}
                    <td className="py-3.5 px-4 sm:px-6">
                      <StatusBadge status={inv.cashpilotStatus} size="sm" />
                    </td>

                    {/* Provenance Badge */}
                    <td className="py-3.5 px-4 sm:px-6">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] border ${provenance.badgeClass}`}
                      >
                        <span className="font-mono text-[10px]" aria-hidden="true">
                          {provenance.symbol}
                        </span>
                        <span>{provenance.label}</span>
                      </span>
                    </td>

                    {/* Action */}
                    <td className="py-3.5 px-4 sm:px-6 text-right">
                      <Link
                        href={`/invoices/${inv.id}`}
                        className="inline-flex items-center gap-1 text-[#0C7C61] hover:underline font-medium text-xs touch-target"
                      >
                        <span>View</span>
                        <ArrowRight className="w-3.5 h-3.5" />
                      </Link>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
