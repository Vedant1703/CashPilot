"use client";

import React, { useState, useMemo, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { formatMoney } from "@/lib/money";
import { StatusBadge } from "@/components/invoices/status-badge";
import {
  getInvoiceProvenance,
  diffInDays,
  parseDate,
  type InvoiceRecord,
} from "@/lib/dashboard/metrics";
import { CashPilotStatus } from "@prisma/client";
import { Search, ArrowRight, ArrowUpDown, ChevronLeft, ChevronRight } from "lucide-react";

export function parseStatusParam(param: string | null | undefined): string {
  if (!param) return "ALL";
  const normalized = param.toLowerCase().trim();
  switch (normalized) {
    case "draft":
      return "DRAFT";
    case "unpaid":
    case "awaiting":
    case "awaiting_payment":
      return "AWAITING_PAYMENT";
    case "due_soon":
    case "duesoon":
      return "DUE_SOON";
    case "overdue":
      return "OVERDUE";
    case "paid":
    case "paypal_paid":
      return "PAID";
    case "simulated_paid":
    case "simulated-paid":
    case "simulated":
      return "SIMULATED_PAID";
    case "cancelled":
      return "CANCELLED";
    case "needs_review":
    case "needsreview":
      return "NEEDS_REVIEW";
    default:
      return "ALL";
  }
}

export function filterToStatusParam(filterKey: string): string | null {
  switch (filterKey) {
    case "DRAFT":
      return "draft";
    case "AWAITING_PAYMENT":
      return "unpaid";
    case "DUE_SOON":
      return "due_soon";
    case "OVERDUE":
      return "overdue";
    case "PAID":
      return "paid";
    case "SIMULATED_PAID":
      return "simulated_paid";
    case "CANCELLED":
      return "cancelled";
    case "NEEDS_REVIEW":
      return "needs_review";
    default:
      return null; // canonical default "ALL" view (/invoices) has no status param
  }
}

interface InvoiceTableProps {
  invoices: InvoiceRecord[];
  initialFilter?: string;
  initialSearch?: string;
  nowUtc?: string;
}

export function InvoiceTable({
  invoices,
  initialFilter = "ALL",
  initialSearch = "",
  nowUtc,
}: InvoiceTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const now = useMemo(() => (nowUtc ? new Date(nowUtc) : new Date()), [nowUtc]);

  // Derive filter from URL query param; safely fall back to initialFilter or "ALL"
  const urlStatusParam = searchParams?.get("status") ?? searchParams?.get("filter");
  const filter = parseStatusParam(urlStatusParam ?? initialFilter);

  // Derive search query from URL query param, falling back to initialSearch
  const urlSearchParam = searchParams?.get("q") ?? searchParams?.get("search") ?? "";
  const [prevUrlSearch, setPrevUrlSearch] = useState(urlSearchParam);
  const [searchQuery, setSearchQuery] = useState(urlSearchParam || initialSearch);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Synchronize local search input when URL changes (e.g. browser back/forward)
  if (urlSearchParam !== prevUrlSearch) {
    setPrevUrlSearch(urlSearchParam);
    setSearchQuery(urlSearchParam);
  }

  const [sortField, setSortField] = useState<"dueDate" | "invoiceDate" | "amount" | "number">("dueDate");
  const [sortAsc, setSortAsc] = useState<boolean>(true);

  // Clean up debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  const hasDemoInvoices = useMemo(() => invoices.some((i) => i.isDemoData), [invoices]);

  // Filter tabs config
  const tabs = useMemo(() => {
    const list = [
      { key: "ALL", label: "All" },
      { key: "DRAFT", label: "Draft" },
      { key: "AWAITING_PAYMENT", label: "Awaiting" },
      { key: "DUE_SOON", label: "Due Soon" },
      { key: "OVERDUE", label: "Overdue" },
      { key: "PAID", label: hasDemoInvoices ? "PayPal Paid" : "Paid" },
    ];
    if (hasDemoInvoices) {
      list.push({ key: "SIMULATED_PAID", label: "Simulated Paid" });
    }
    list.push({ key: "NEEDS_REVIEW", label: "Needs Review" });
    return list;
  }, [hasDemoInvoices]);

  // Update status filter in URL while preserving search query
  const handleTabClick = (tabKey: string) => {
    const nextParams = new URLSearchParams();
    const statusParam = filterToStatusParam(tabKey);
    if (statusParam) {
      nextParams.set("status", statusParam);
    }
    if (searchQuery.trim()) {
      nextParams.set("q", searchQuery.trim());
    }

    const queryStr = nextParams.toString();
    const nextUrl = queryStr ? `${pathname}?${queryStr}` : pathname;
    router.push(nextUrl, { scroll: false });
  };

  // Update search query state and URL (debounced to avoid typing lag)
  const handleSearchChange = (val: string) => {
    setSearchQuery(val);

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      const nextParams = new URLSearchParams();
      const statusParam = filterToStatusParam(filter);
      if (statusParam) {
        nextParams.set("status", statusParam);
      }
      if (val.trim()) {
        nextParams.set("q", val.trim());
      }

      const queryStr = nextParams.toString();
      const nextUrl = queryStr ? `${pathname}?${queryStr}` : pathname;
      router.replace(nextUrl, { scroll: false });
    }, 200);
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      const nextParams = new URLSearchParams();
      const statusParam = filterToStatusParam(filter);
      if (statusParam) {
        nextParams.set("status", statusParam);
      }
      if (searchQuery.trim()) {
        nextParams.set("q", searchQuery.trim());
      }

      const queryStr = nextParams.toString();
      const nextUrl = queryStr ? `${pathname}?${queryStr}` : pathname;
      router.replace(nextUrl, { scroll: false });
    }
  };

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
          } else if (filter === "SIMULATED_PAID") {
            if (inv.cashpilotStatus !== CashPilotStatus.PAID || !inv.isDemoData) return false;
          } else if (filter === "PAID") {
            if (inv.cashpilotStatus !== CashPilotStatus.PAID) return false;
            // When demo data exists with simulated invoices, PayPal Paid shows real/verified provider paid
            if (hasDemoInvoices && inv.isDemoData) return false;
          } else if (inv.cashpilotStatus !== filter) {
            return false;
          }
        }

        // Search filtering: matches invoice number, id, paypal ID, client name, company, title, email
        if (searchQuery.trim().length > 0) {
          const q = searchQuery.toLowerCase().trim();
          const cleanQ = q.replace(/[^a-z0-9]/gi, "");

          const matchNumber =
            (inv.number?.toLowerCase().includes(q) ?? false) ||
            (cleanQ.length > 0 &&
              (inv.number?.replace(/[^a-z0-9]/gi, "").toLowerCase().includes(cleanQ) ?? false));
          const matchId =
            inv.id.toLowerCase().includes(q) ||
            (cleanQ.length > 0 && inv.id.replace(/[^a-z0-9]/gi, "").toLowerCase().includes(cleanQ));
          const matchPayPalId = inv.paypalInvoiceId?.toLowerCase().includes(q) ?? false;
          const matchClient = inv.client.name.toLowerCase().includes(q);
          const matchCompany = inv.client.company?.toLowerCase().includes(q) ?? false;
          const matchTitle = inv.title?.toLowerCase().includes(q) ?? false;
          const matchEmail = inv.client.email.toLowerCase().includes(q);

          if (
            !matchNumber &&
            !matchId &&
            !matchPayPalId &&
            !matchClient &&
            !matchCompany &&
            !matchTitle &&
            !matchEmail
          ) {
            return false;
          }
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
        if (sortField === "invoiceDate") {
          const dateA = parseDate(a.invoiceDate).getTime();
          const dateB = parseDate(b.invoiceDate).getTime();
          return sortAsc ? dateA - dateB : dateB - dateA;
        }
        // Default: due date
        const dateA = parseDate(a.dueDate).getTime();
        const dateB = parseDate(b.dueDate).getTime();
        return sortAsc ? dateA - dateB : dateB - dateA;
      });
  }, [invoices, filter, searchQuery, sortField, sortAsc, now]);

  const toggleSort = (field: "dueDate" | "invoiceDate" | "amount" | "number") => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(true);
    }
  };

  // Pagination Configuration & Slicing (15 items per page)
  const PAGE_SIZE = 15;
  const rawPageParam = searchParams?.get("page");
  const urlPage = rawPageParam ? parseInt(rawPageParam, 10) : 1;
  const validUrlPage = !isNaN(urlPage) && urlPage > 0 ? urlPage : 1;

  const totalPages = Math.max(1, Math.ceil(filteredInvoices.length / PAGE_SIZE));
  const currentPage = Math.min(validUrlPage, totalPages);

  const paginatedInvoices = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return filteredInvoices.slice(start, start + PAGE_SIZE);
  }, [filteredInvoices, currentPage]);

  const handlePageChange = (newPage: number) => {
    const targetPage = Math.max(1, Math.min(newPage, totalPages));
    const nextParams = new URLSearchParams();
    const statusParam = filterToStatusParam(filter);
    if (statusParam) nextParams.set("status", statusParam);
    if (searchQuery.trim()) nextParams.set("q", searchQuery.trim());
    if (targetPage > 1) nextParams.set("page", String(targetPage));

    const queryStr = nextParams.toString();
    const nextUrl = queryStr ? `${pathname}?${queryStr}` : pathname;
    router.push(nextUrl, { scroll: false });
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
                onClick={() => handleTabClick(tab.key)}
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
            onChange={(e) => handleSearchChange(e.target.value)}
            onKeyDown={handleSearchKeyDown}
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
                  onClick={() => toggleSort("invoiceDate")}
                  className="inline-flex items-center gap-1 hover:text-[#12263F]"
                >
                  <span>Issue Date</span>
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
                <td colSpan={8} className="py-12 text-center text-xs text-[#5E718D]">
                  No invoices matched your filter criteria.
                </td>
              </tr>
            ) : (
              paginatedInvoices.map((inv) => {
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
                    tabIndex={0}
                    role="row"
                    aria-label={`Invoice ${inv.number ?? inv.id.slice(0, 10)} for ${inv.client.name}`}
                    onClick={(e) => {
                      const target = e.target as HTMLElement;
                      const closestInteractive = target.closest("a, button, input, select, textarea");
                      if (closestInteractive && closestInteractive !== e.currentTarget) {
                        return;
                      }
                      router.push(`/invoices/${inv.id}`);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        const target = e.target as HTMLElement;
                        const closestInteractive = target.closest("a, button, input, select, textarea");
                        if (closestInteractive && closestInteractive !== e.currentTarget) {
                          return;
                        }
                        e.preventDefault();
                        router.push(`/invoices/${inv.id}`);
                      }
                    }}
                    className="cursor-pointer hover:bg-[#F6F5F1] focus:outline-none focus-visible:bg-[#EEF2F6] focus-visible:ring-1 focus-visible:ring-[#0C7C61] transition-colors group"
                  >
                    {/* Invoice ID / Number */}
                    <td className="py-3.5 px-4 sm:px-6 font-mono font-semibold text-[#12263F]">
                      <Link
                        href={`/invoices/${inv.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="hover:text-[#0C7C61] hover:underline focus:outline-none focus-visible:underline"
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

                    {/* Issue Date */}
                    <td className="py-3.5 px-4 sm:px-6 font-mono text-xs text-[#5E718D]">
                      {new Date(inv.invoiceDate).toLocaleDateString([], {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </td>

                    {/* Due Date */}
                    <td className={`py-3.5 px-4 sm:px-6 font-mono text-xs ${dueClass}`}>
                      {dueLabel}
                    </td>

                    {/* Status Badge */}
                    <td className="py-3.5 px-4 sm:px-6">
                      <StatusBadge status={inv.cashpilotStatus} isDemoData={inv.isDemoData} size="sm" />
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
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-1 text-[#0C7C61] hover:underline font-medium text-xs touch-target focus:outline-none focus-visible:underline"
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

      {/* Pagination Footer */}
      {filteredInvoices.length > 0 && (
        <div className="border-t border-[#E3E8EF] px-4 py-3.5 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-3 bg-[#F8FAFC]/50 text-xs text-[#64748B]">
          <div>
            Showing{" "}
            <span className="font-semibold text-[#1B2559]">
              {(currentPage - 1) * PAGE_SIZE + 1}
            </span>{" "}
            to{" "}
            <span className="font-semibold text-[#1B2559]">
              {Math.min(currentPage * PAGE_SIZE, filteredInvoices.length)}
            </span>{" "}
            of{" "}
            <span className="font-semibold text-[#1B2559]">
              {filteredInvoices.length}
            </span>{" "}
            {filteredInvoices.length === 1 ? "invoice" : "invoices"}
          </div>

          {totalPages > 1 && (
            <nav aria-label="Invoice table pagination" className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => handlePageChange(currentPage - 1)}
                disabled={currentPage <= 1}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[#E3E8EF] bg-white text-xs font-medium text-[#475569] hover:bg-[#F1F5F9] disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0C7C61]"
                aria-label="Go to previous page"
              >
                <ChevronLeft className="w-4 h-4" />
                <span className="hidden sm:inline">Previous</span>
              </button>

              <div className="flex items-center gap-1">
                {Array.from({ length: totalPages }, (_, i) => i + 1).map((pageNum) => {
                  if (
                    totalPages > 7 &&
                    pageNum !== 1 &&
                    pageNum !== totalPages &&
                    Math.abs(pageNum - currentPage) > 1
                  ) {
                    if (pageNum === 2 && currentPage > 4) {
                      return (
                        <span key="ellipsis-start" className="px-1 text-[#94A3B8]">
                          …
                        </span>
                      );
                    }
                    if (pageNum === totalPages - 1 && currentPage < totalPages - 3) {
                      return (
                        <span key="ellipsis-end" className="px-1 text-[#94A3B8]">
                          …
                        </span>
                      );
                    }
                    return null;
                  }

                  const isActive = pageNum === currentPage;
                  return (
                    <button
                      key={pageNum}
                      type="button"
                      onClick={() => handlePageChange(pageNum)}
                      aria-current={isActive ? "page" : undefined}
                      aria-label={`Page ${pageNum}`}
                      className={`min-w-[32px] h-8 rounded-lg text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0C7C61] ${
                        isActive
                          ? "bg-[#0C7C61] text-white shadow-xs"
                          : "border border-[#E3E8EF] bg-white text-[#475569] hover:bg-[#F1F5F9]"
                      }`}
                    >
                      {pageNum}
                    </button>
                  );
                })}
              </div>

              <button
                type="button"
                onClick={() => handlePageChange(currentPage + 1)}
                disabled={currentPage >= totalPages}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[#E3E8EF] bg-white text-xs font-medium text-[#475569] hover:bg-[#F1F5F9] disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0C7C61]"
                aria-label="Go to next page"
              >
                <span className="hidden sm:inline">Next</span>
                <ChevronRight className="w-4 h-4" />
              </button>
            </nav>
          )}
        </div>
      )}
    </div>
  );
}
