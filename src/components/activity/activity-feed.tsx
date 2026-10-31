"use client";

import React, { useState, useTransition, useMemo } from "react";
import {
  Search,
  CheckCircle2,
  Clock,
  AlertTriangle,
  ShieldCheck,
  ShieldAlert,
  Sparkles,
  RefreshCw,
  ChevronRight,
  X,
  HelpCircle,
} from "lucide-react";
import type {
  ActivityItem,
  InvoiceJourneyTrace,
  InvoiceSelectorOption,
  OutcomeBadgeVariant,
} from "@/lib/services/activity.service";
import { InvoiceJourneyTracker } from "./invoice-journey-tracker";
import { SecurityExplainerCard } from "./security-explainer-card";

interface ActivityFeedProps {
  initialItems: ActivityItem[];
  initialTrace: InvoiceJourneyTrace | null;
  selectorOptions: InvoiceSelectorOption[];
  workspaceId: string;
  initialInvoiceId?: string;
}

export function ActivityFeed({
  initialItems,
  initialTrace,
  selectorOptions,
  workspaceId,
  initialInvoiceId,
}: ActivityFeedProps) {
  const [items, setItems] = useState<ActivityItem[]>(initialItems);
  const [trace, setTrace] = useState<InvoiceJourneyTrace | null>(initialTrace);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(
    initialInvoiceId || initialTrace?.invoiceId || selectorOptions[0]?.id || null
  );

  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [resultFilter, setResultFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");

  const [isLoadingFeed, setIsLoadingFeed] = useState<boolean>(false);
  const [isLoadingTrace, setIsLoadingTrace] = useState<boolean>(false);
  const [, startTransition] = useTransition();

  // Fetch updated feed when filters change
  const fetchFeed = async (newType = typeFilter, newResult = resultFilter, newSearch = searchQuery) => {
    setIsLoadingFeed(true);
    try {
      const params = new URLSearchParams();
      if (workspaceId) params.set("workspaceId", workspaceId);
      if (newType !== "all") params.set("type", newType);
      if (newResult !== "all") params.set("result", newResult);
      if (newSearch.trim()) params.set("search", newSearch.trim());

      const res = await fetch(`/api/activity?${params.toString()}`);
      const json = await res.json();
      if (json.success && json.data) {
        setItems(json.data.items);
      }
    } catch (err) {
      console.error("Failed to fetch activity feed:", err);
    } finally {
      setIsLoadingFeed(false);
    }
  };

  // Fetch updated invoice trace when selection changes
  const handleSelectInvoice = async (invoiceId: string) => {
    setSelectedInvoiceId(invoiceId);
    setIsLoadingTrace(true);
    try {
      const params = new URLSearchParams({ workspaceId, invoiceId });
      const res = await fetch(`/api/activity?${params.toString()}`);
      const json = await res.json();
      if (json.success && json.data && json.data.invoiceTrace) {
        setTrace(json.data.invoiceTrace);
      }
    } catch (err) {
      console.error("Failed to fetch invoice trace:", err);
    } finally {
      setIsLoadingTrace(false);
    }
  };

  const handleTypeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setTypeFilter(val);
    startTransition(() => {
      fetchFeed(val, resultFilter, searchQuery);
    });
  };

  const handleResultChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setResultFilter(val);
    startTransition(() => {
      fetchFeed(typeFilter, val, searchQuery);
    });
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    startTransition(() => {
      fetchFeed(typeFilter, resultFilter, searchQuery);
    });
  };

  const handleResetFilters = () => {
    setTypeFilter("all");
    setResultFilter("all");
    setSearchQuery("");
    startTransition(() => {
      fetchFeed("all", "all", "");
    });
  };

  const isFiltered = typeFilter !== "all" || resultFilter !== "all" || searchQuery.trim().length > 0;

  // Group events by dateGroupKey for natural reading
  const groupedEvents = useMemo(() => {
    const groups: { [key: string]: ActivityItem[] } = {};
    for (const item of items) {
      if (!groups[item.dateGroupKey]) {
        groups[item.dateGroupKey] = [];
      }
      groups[item.dateGroupKey].push(item);
    }
    return groups;
  }, [items]);

  const renderOutcomeBadge = (badge: { label: string; variant: OutcomeBadgeVariant }) => {
    switch (badge.variant) {
      case "confirmed":
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-[#E8F5F1] text-[#0C7C61] border border-[#0C7C61]/30 shrink-0">
            <CheckCircle2 className="w-3 h-3 stroke-[2.5]" />
            <span>{badge.label}</span>
          </span>
        );
      case "approved":
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-[#EDF7F4] text-[#096851] border border-[#34C79F]/40 shrink-0">
            <ShieldCheck className="w-3 h-3" />
            <span>{badge.label}</span>
          </span>
        );
      case "proposed":
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-[#F0EEFF] text-[#5B3FD0] border border-[#CDC4FF] shrink-0">
            <Sparkles className="w-3 h-3" />
            <span>{badge.label}</span>
          </span>
        );
      case "partial":
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-[#FEF9E7] text-[#7A5600] border border-[#F3E0A2] shrink-0">
            <AlertTriangle className="w-3 h-3" />
            <span>{badge.label}</span>
          </span>
        );
      case "rejected":
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-[#FEF3F2] text-[#B42318] border border-[#FECDCA] shrink-0">
            <ShieldAlert className="w-3 h-3" />
            <span>{badge.label}</span>
          </span>
        );
      case "unknown":
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-[#FDF2EB] text-[#B4440B] border border-[#F8D2BD] shrink-0">
            <HelpCircle className="w-3 h-3" />
            <span>{badge.label}</span>
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-[#F6F5F1] text-[#5E718D] border border-[#E3E8EF] shrink-0">
            {badge.label}
          </span>
        );
    }
  };

  return (
    <div className="space-y-6">
      {/* Page Title & Environment Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-[#E3E8EF]">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-[#12263F]">
              Activity
            </h1>
            <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-[#12263F] text-white tracking-wider">
              PayPal Sandbox
            </span>
          </div>
          <p className="text-xs sm:text-sm text-[#5E718D]">
            A permanent record of what was proposed, approved and confirmed
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => fetchFeed()}
            disabled={isLoadingFeed}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[#E3E8EF] bg-white hover:bg-[#F6F5F1] text-[#12263F] text-xs font-semibold shadow-2xs transition-colors touch-target disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoadingFeed ? "animate-spin text-[#0C7C61]" : "text-[#5E718D]"}`} />
            <span>Refresh Log</span>
          </button>
        </div>
      </div>

      {/* 2-Column Responsive Layout (Page 15) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Timeline Feed (8 cols) */}
        <section
          aria-label="Activity Timeline"
          className="lg:col-span-8 rounded-2xl border border-[#E3E8EF] bg-white p-5 sm:p-6 shadow-xs space-y-5"
        >
          {/* Filter Toolbar (Page 15) */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pb-4 border-b border-[#EEF2F6]">
            <div className="flex flex-wrap items-center gap-2.5">
              {/* Type Filter */}
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-semibold text-[#5E718D]">Type:</span>
                <select
                  value={typeFilter}
                  onChange={handleTypeChange}
                  aria-label="Filter by event type"
                  className="text-xs font-medium py-1.5 px-2.5 rounded-lg border border-[#E3E8EF] bg-[#F6F5F1] text-[#12263F] focus:outline-hidden focus:ring-2 focus:ring-[#0C7C61] cursor-pointer"
                >
                  <option value="all">All</option>
                  <option value="ai">AI Proposals</option>
                  <option value="approval">Approvals</option>
                  <option value="operation">PayPal Calls</option>
                  <option value="sync">Status Sync</option>
                  <option value="security">Security Checks</option>
                </select>
              </div>

              {/* Result Filter */}
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-semibold text-[#5E718D]">Result:</span>
                <select
                  value={resultFilter}
                  onChange={handleResultChange}
                  aria-label="Filter by outcome result"
                  className="text-xs font-medium py-1.5 px-2.5 rounded-lg border border-[#E3E8EF] bg-[#F6F5F1] text-[#12263F] focus:outline-hidden focus:ring-2 focus:ring-[#0C7C61] cursor-pointer"
                >
                  <option value="all">All</option>
                  <option value="confirmed">Confirmed by PayPal</option>
                  <option value="approved">Approved</option>
                  <option value="proposed">AI Proposed</option>
                  <option value="partial">Partial</option>
                  <option value="rejected">Rejected</option>
                  <option value="unknown">Was Unknown</option>
                </select>
              </div>

              {isFiltered && (
                <button
                  type="button"
                  onClick={handleResetFilters}
                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#5B3FD0] hover:underline"
                >
                  <X className="w-3 h-3" />
                  <span>Reset</span>
                </button>
              )}
            </div>

            {/* Keyword Search */}
            <form onSubmit={handleSearchSubmit} className="relative sm:w-56">
              <input
                type="text"
                placeholder="Search events..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full text-xs py-1.5 pl-8 pr-3 rounded-lg border border-[#E3E8EF] bg-[#F6F5F1] text-[#12263F] placeholder-[#8C9BAE] focus:outline-hidden focus:ring-2 focus:ring-[#0C7C61]"
              />
              <Search className="w-3.5 h-3.5 text-[#8C9BAE] absolute left-2.5 top-2.5" />
            </form>
          </div>

          {/* Timeline Stream */}
          {isLoadingFeed ? (
            <div className="py-16 flex flex-col items-center justify-center text-center space-y-2">
              <div className="w-6 h-6 border-2 border-[#0C7C61] border-t-transparent rounded-full animate-spin" />
              <p className="text-xs text-[#5E718D]">Loading audit events...</p>
            </div>
          ) : items.length === 0 ? (
            <div className="py-12 text-center space-y-2">
              <div className="w-10 h-10 rounded-full bg-[#F6F5F1] text-[#5E718D] flex items-center justify-center mx-auto">
                <Clock className="w-5 h-5" />
              </div>
              <h4 className="text-sm font-semibold text-[#12263F]">No activity events found</h4>
              <p className="text-xs text-[#5E718D] max-w-sm mx-auto">
                {isFiltered
                  ? "No events match the selected type or result filters."
                  : "No audit events have been recorded in this workspace yet."}
              </p>
              {isFiltered && (
                <button
                  type="button"
                  onClick={handleResetFilters}
                  className="mt-2 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-[#E3E8EF] bg-white text-xs font-semibold text-[#12263F] hover:bg-[#F6F5F1]"
                >
                  Clear all filters
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-6">
              {Object.entries(groupedEvents).map(([dateKey, eventList]) => (
                <div key={dateKey} className="space-y-3">
                  {/* Date Heading (Page 15) */}
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-xs text-[#12263F] tracking-tight">
                      {dateKey}
                    </span>
                    <span className="h-[1px] flex-1 bg-[#EEF2F6]" />
                  </div>

                  {/* Event Rows */}
                  <div className="divide-y divide-[#EEF2F6] rounded-xl border border-[#EEF2F6] overflow-hidden">
                    {eventList.map((item) => {
                      const isSelected = item.invoiceId && item.invoiceId === selectedInvoiceId;

                      return (
                        <div
                          key={item.id}
                          onClick={() => {
                            if (item.invoiceId) {
                              handleSelectInvoice(item.invoiceId);
                            }
                          }}
                          className={`p-3.5 sm:p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-colors ${
                            item.invoiceId ? "cursor-pointer hover:bg-[#F6F5F1]/60" : ""
                          } ${isSelected ? "bg-[#E8F5F1]/30 border-l-4 border-l-[#0C7C61]" : ""}`}
                        >
                          {/* Time & Content */}
                          <div className="flex items-start gap-3 min-w-0">
                            {/* Timestamp */}
                            <span className="font-mono text-xs text-[#5E718D] pt-0.5 w-11 shrink-0 font-medium">
                              {item.timeFormatted}
                            </span>

                            <div className="space-y-1 min-w-0">
                              {/* Main Title & Target */}
                              <div className="flex flex-wrap items-baseline gap-1.5">
                                <span className="font-semibold text-xs text-[#12263F] leading-snug">
                                  {item.title}
                                </span>
                              </div>

                              {/* Subtitle / Actor + Summary */}
                              <p className="text-xs text-[#5E718D] leading-relaxed">
                                {item.subtitle}
                              </p>
                            </div>
                          </div>

                          {/* Outcome Badge & Trace Hint */}
                          <div className="flex items-center gap-2 self-start sm:self-center pl-14 sm:pl-0 shrink-0">
                            {renderOutcomeBadge(item.outcomeBadge)}

                            {item.invoiceId && (
                              <ChevronRight className="w-4 h-4 text-[#8C9BAE] hidden sm:block" />
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Right Column: Secondary Side Panels (4 cols) */}
        <aside aria-label="Invoice Journey & Security Details" className="lg:col-span-4 space-y-6">
          {/* Card 1: Follow one invoice end to end (Page 15) */}
          <InvoiceJourneyTracker
            trace={trace}
            selectorOptions={selectorOptions}
            selectedInvoiceId={selectedInvoiceId}
            onSelectInvoice={handleSelectInvoice}
            isLoading={isLoadingTrace}
          />

          {/* Card 2: What is recorded (Page 15) */}
          <SecurityExplainerCard />
        </aside>
      </div>
    </div>
  );
}
