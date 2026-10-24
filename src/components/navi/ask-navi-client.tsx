"use client";

import React, { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { NaviAvatar } from "@/components/navi/navi-avatar";
import {
  Sparkles,
  AlertCircle,
  FileText,
  Clock,
  ShieldCheck,
  ArrowRight,
  RefreshCw,
  Info,
  FilePlus,
  Users,
  Calendar,
  AlertTriangle,
  RotateCcw,
} from "lucide-react";
import type {
  NaviChatMessage,
  RankedInvoiceItem,
  AvailableClientItem,
} from "@/lib/services/ask-navi.service";

let msgCounter = 0;
function nextMsgId(prefix: string): string {
  msgCounter += 1;
  return `${prefix}-${msgCounter}`;
}

interface DataCounts {
  total: number;
  overdue: number;
  unpaid: number;
  paid: number;
  dueToday: number;
  dueSoon: number;
}

interface AskNaviClientProps {
  initialRankedInvoices: RankedInvoiceItem[];
  lastSyncAt?: string | null;
  initialAvailableClients?: AvailableClientItem[];
  initialDataCounts?: DataCounts;
}

export function AskNaviClient({
  initialRankedInvoices,
  lastSyncAt,
  initialAvailableClients = [],
  initialDataCounts,
}: AskNaviClientProps) {
  const [messages, setMessages] = useState<NaviChatMessage[]>([
    {
      id: "welcome-msg",
      role: "assistant",
      content:
        "Hi! I'm Navi, your guided receivables copilot. Select a question below to analyze your receivables, check overdue accounts, or inspect priorities. All answers are grounded strictly in your verified invoices and PayPal Sandbox status.",
      createdAt: "",
      source: "deterministic_rule_based",
      modelName: "cashpilot-assistant-v1",
    },
  ]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastQuestion, setLastQuestion] = useState<string | null>(null);
  const [rankedInvoices, setRankedInvoices] = useState<RankedInvoiceItem[]>(initialRankedInvoices);
  const [availableClients, setAvailableClients] = useState<AvailableClientItem[]>(initialAvailableClients);
  const [showClientSelector, setShowClientSelector] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  // Determine which initial questions to display based on ground-truth data counts
  const dataCounts = initialDataCounts ?? {
    total: rankedInvoices.length,
    overdue: rankedInvoices.filter((i) => i.status === "OVERDUE").length,
    unpaid: rankedInvoices.length,
    paid: 0,
    dueToday: 0,
    dueSoon: rankedInvoices.filter((i) => i.status === "DUE_SOON").length,
  };

  // Build the guided question options
  const coreQuestions: Array<{ label: string; text: string; icon: React.ReactNode; isRelevant: boolean }> = [
    {
      label: "Which invoices need attention first?",
      text: "Which invoices need attention first?",
      icon: <AlertTriangle className="w-3.5 h-3.5 text-[#B42318]" />,
      isRelevant: true,
    },
    {
      label: "Summarize all invoices",
      text: "Summarize all invoices",
      icon: <FileText className="w-3.5 h-3.5 text-[#0C7C61]" />,
      isRelevant: true,
    },
    {
      label: "List all invoices",
      text: "List all invoices",
      icon: <FileText className="w-3.5 h-3.5 text-[#5E718D]" />,
      isRelevant: true,
    },
    {
      label: "Show overdue invoices",
      text: "Show overdue invoices",
      icon: <Clock className="w-3.5 h-3.5 text-[#B42318]" />,
      isRelevant: dataCounts.overdue > 0,
    },
    {
      label: "Show unpaid invoices",
      text: "Show unpaid invoices",
      icon: <FileText className="w-3.5 h-3.5 text-[#E08A00]" />,
      isRelevant: dataCounts.unpaid > 0,
    },
    {
      label: "Show paid invoices",
      text: "Show paid invoices",
      icon: <ShieldCheck className="w-3.5 h-3.5 text-[#0C7C61]" />,
      isRelevant: dataCounts.paid > 0,
    },
    {
      label: "What is due today?",
      text: "What is due today?",
      icon: <Calendar className="w-3.5 h-3.5 text-[#0C7C61]" />,
      isRelevant: dataCounts.dueToday > 0,
    },
    {
      label: "What is due this week?",
      text: "What is due this week?",
      icon: <Calendar className="w-3.5 h-3.5 text-[#5E718D]" />,
      isRelevant: dataCounts.dueSoon > 0,
    },
  ];

  // Filter to relevant questions only
  const activeGuidedQuestions = coreQuestions.filter((q) => q.isRelevant);

  const handleSendMessage = async (questionText: string) => {
    const text = questionText.trim();
    if (!text || isLoading) return;

    setError(null);
    setLastQuestion(text);
    setShowClientSelector(false);

    const userMessage: NaviChatMessage = {
      id: nextMsgId("user"),
      role: "user",
      content: text,
      createdAt: "",
      source: "deterministic_rule_based",
      modelName: "user",
    };

    setMessages((prev) => [...prev, userMessage]);
    setIsLoading(true);

    try {
      const res = await fetch("/api/navi-ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          history: messages.slice(-6).map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });

      const json = await res.json();

      if (res.ok && json.success && json.data) {
        setMessages((prev) => [...prev, json.data.message]);
        if (json.data.rankedInvoices && json.data.rankedInvoices.length > 0) {
          setRankedInvoices(json.data.rankedInvoices);
        }
        if (json.data.availableClients && json.data.availableClients.length > 0) {
          setAvailableClients(json.data.availableClients);
        }
      } else {
        setError(json.error || "Failed to get a response from Navi.");
      }
    } catch {
      setError("Network error while connecting to Ask Navi. Please check your connection.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleResetChat = () => {
    setMessages([
      {
        id: "welcome-msg",
        role: "assistant",
        content:
          "Hi! I'm Navi, your guided receivables copilot. Select a question below to analyze your receivables, check overdue accounts, or inspect priorities. All answers are grounded strictly in your verified invoices and PayPal Sandbox status.",
        createdAt: "",
        source: "deterministic_rule_based",
        modelName: "cashpilot-assistant-v1",
      },
    ]);
    setError(null);
    setLastQuestion(null);
    setShowClientSelector(false);
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-[#E3E8EF]">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-headline font-bold text-2xl sm:text-3xl text-[#12263F] tracking-tight">
              Ask Navi
            </h1>
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-[#E8F5F1] text-[#0C7C61]">
              Guided Copilot
            </span>
          </div>
          <p className="text-xs sm:text-sm text-[#5E718D] mt-1">
            Answers come from your invoices and PayPal&apos;s status, nothing else
          </p>
        </div>

        <div className="flex items-center gap-2.5 text-xs text-[#5E718D]">
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white border border-[#E3E8EF] shadow-2xs font-mono">
            <span className="w-2 h-2 rounded-full bg-[#34C79F] animate-pulse" />
            PayPal Sandbox
          </span>
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#F6F5F1] border border-[#E3E8EF] text-[#5E718D]">
            <Clock className="w-3.5 h-3.5" />
            {lastSyncAt ? "Synced recently" : "Synced 4 min ago"}
          </span>
        </div>
      </div>

      {/* Main Grid: Guided Chatbot (2 cols) + Ranked For You (1 col) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {/* Left Column: Conversation Area & Guided Options */}
        <div className="lg:col-span-2 flex flex-col h-[700px] bg-white rounded-2xl border border-[#E3E8EF] shadow-xs overflow-hidden">
          {/* Header Bar inside Chat Area */}
          <div className="px-5 py-3 border-b border-[#E3E8EF] bg-[#FAFAFA] flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-medium text-[#12263F]">
              <Sparkles className="w-4 h-4 text-[#0C7C61]" />
              <span>Guided Conversation</span>
            </div>
            <button
              type="button"
              onClick={handleResetChat}
              disabled={isLoading || messages.length <= 1}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-[#5E718D] hover:text-[#12263F] hover:bg-white border border-transparent hover:border-[#E3E8EF] transition-colors disabled:opacity-40"
            >
              <RotateCcw className="w-3 h-3" />
              Reset chat
            </button>
          </div>

          {/* Messages Scroll Area */}
          <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-5">
            {messages.map((msg, index) => {
              const isUser = msg.role === "user";
              const isLatestAssistant = !isUser && index === messages.length - 1;

              if (isUser) {
                return (
                  <div key={msg.id} className="flex justify-end animate-in fade-in duration-200">
                    <div className="max-w-[85%] sm:max-w-[75%] rounded-2xl rounded-br-xs bg-[#12263F] text-white px-4 py-3 text-sm shadow-xs leading-relaxed">
                      {msg.content}
                    </div>
                  </div>
                );
              }

              // Assistant message
              return (
                <div key={msg.id} className="flex items-start gap-3 animate-in fade-in duration-200">
                  <NaviAvatar state="idle" size={36} className="shrink-0 mt-1" />

                  <div className="flex-1 space-y-3 max-w-[95%] sm:max-w-[90%]">
                    {/* Assistant Card Header */}
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-xs text-[#12263F]">Navi</span>
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[#E8F5F1] text-[#0C7C61]">
                        <Sparkles className="w-2.5 h-2.5" />
                        AI proposed
                      </span>
                    </div>

                    {/* Content Box */}
                    <div
                      className={`rounded-2xl rounded-tl-xs p-4 sm:p-5 text-sm leading-relaxed border ${
                        msg.isRefusal
                          ? "bg-[#FEF7F6] border-[#FECDCA] text-[#12263F]"
                          : "bg-[#FAFAFA] border-[#E3E8EF] text-[#12263F]"
                      }`}
                    >
                      {msg.isRefusal && (
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-[#B42318] mb-2">
                          <AlertCircle className="w-4 h-4 shrink-0" />
                          <span>Safety Guardrail Enforced</span>
                        </div>
                      )}

                      <div className="whitespace-pre-wrap space-y-2">{msg.content}</div>

                      {/* Evidence Breakdown Grid (When ranking evidence is present) */}
                      {msg.rankingEvidence && (
                        <div className="mt-4 pt-4 border-t border-[#E3E8EF] space-y-3">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-bold text-[#12263F]">
                              Why {msg.rankingEvidence.clientName} is first
                            </span>
                            <span className="text-[10px] uppercase font-mono text-[#5E718D]">
                              {msg.rankingEvidence.invoiceNumber}
                            </span>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                            <div className="p-2.5 rounded-xl bg-white border border-[#E3E8EF] flex items-center justify-between">
                              <span className="text-[#5E718D]">Days overdue</span>
                              <span className="font-semibold text-[#B42318]">
                                {msg.rankingEvidence.daysOverdue}{" "}
                                <span className="text-[10px] font-normal text-[#5E718D]">CALCULATED</span>
                              </span>
                            </div>

                            <div className="p-2.5 rounded-xl bg-white border border-[#E3E8EF] flex items-center justify-between">
                              <span className="text-[#5E718D]">Amount</span>
                              <span className="font-semibold text-[#12263F]">
                                {msg.rankingEvidence.amount}{" "}
                                <span className="text-[10px] font-normal text-[#5E718D]">YOUR INVOICE</span>
                              </span>
                            </div>

                            <div className="p-2.5 rounded-xl bg-white border border-[#E3E8EF] flex items-center justify-between">
                              <span className="text-[#5E718D]">PayPal status</span>
                              <span className="font-semibold text-[#0C7C61]">
                                {msg.rankingEvidence.paypalStatus}
                              </span>
                            </div>

                            <div className="p-2.5 rounded-xl bg-white border border-[#E3E8EF] flex items-center justify-between">
                              <span className="text-[#5E718D]">Earlier reminders</span>
                              <span className="font-semibold text-[#12263F]">
                                {msg.rankingEvidence.earlierReminders}
                              </span>
                            </div>

                            <div className="p-2.5 rounded-xl bg-white border border-[#E3E8EF] flex items-center justify-between sm:col-span-2">
                              <span className="text-[#5E718D]">Dispute on record</span>
                              <span className="font-semibold text-[#12263F]">
                                {msg.rankingEvidence.dispute}
                              </span>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Contextual Action Buttons (Always rendered when provided) */}
                      {msg.suggestedActions && msg.suggestedActions.length > 0 && (
                        <div className="mt-4 pt-3 border-t border-[#E3E8EF] space-y-2">
                          <p className="text-[11px] font-semibold text-[#5E718D] uppercase tracking-wider">
                            Suggested actions
                          </p>
                          <div className="flex flex-wrap items-center gap-2">
                            {msg.suggestedActions.map((act) => {
                              const targetHref =
                                act.actionType === "draft_invoice"
                                  ? "/invoices/new"
                                  : act.actionType === "draft_reminder" && act.invoiceId
                                  ? `/invoices/${act.invoiceId}?action=remind`
                                  : act.invoiceId
                                  ? `/invoices/${act.invoiceId}`
                                  : "/invoices";

                              return (
                                <Link
                                  key={act.label}
                                  href={targetHref}
                                  className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold shadow-2xs transition-all hover:scale-[1.02] ${
                                    act.actionType === "draft_reminder"
                                      ? "bg-[#0C7C61] hover:bg-[#096851] text-white"
                                      : act.actionType === "draft_invoice"
                                      ? "bg-[#12263F] hover:bg-[#1E3A5F] text-white"
                                      : "bg-white hover:bg-[#F6F5F1] border border-[#E3E8EF] text-[#12263F]"
                                  }`}
                                >
                                  {act.actionType === "draft_reminder" ? (
                                    <Sparkles className="w-3.5 h-3.5" />
                                  ) : act.actionType === "draft_invoice" ? (
                                    <FilePlus className="w-3.5 h-3.5" />
                                  ) : (
                                    <FileText className="w-3.5 h-3.5 text-[#5E718D]" />
                                  )}
                                  <span>{act.label}</span>
                                  <ArrowRight className="w-3 h-3 ml-0.5" />
                                </Link>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* Contextual Follow-up Questions (Attached to latest assistant message) */}
                      {isLatestAssistant &&
                        msg.suggestedFollowUps &&
                        msg.suggestedFollowUps.length > 0 && (
                          <div className="mt-4 pt-3 border-t border-[#0C7C61]/20 space-y-2">
                            <p className="text-[11px] font-semibold text-[#0C7C61] uppercase tracking-wider flex items-center gap-1.5">
                              <Sparkles className="w-3 h-3" />
                              Follow-up questions
                            </p>
                            <div className="flex flex-wrap gap-2">
                              {msg.suggestedFollowUps.map((question) => (
                                <button
                                  key={question}
                                  type="button"
                                  onClick={() => handleSendMessage(question)}
                                  disabled={isLoading}
                                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white hover:bg-[#E8F5F1] border border-[#0C7C61]/30 hover:border-[#0C7C61] text-xs font-semibold text-[#0C7C61] shadow-2xs transition-all hover:scale-[1.02] cursor-pointer disabled:opacity-50 touch-target"
                                >
                                  <span>{question}</span>
                                  <ArrowRight className="w-3 h-3 text-[#0C7C61]" />
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Loading Indicator */}
            {isLoading && (
              <div className="flex items-center gap-3 animate-pulse">
                <NaviAvatar state="thinking" size={32} className="shrink-0" />
                <div className="rounded-2xl rounded-tl-xs bg-[#FAFAFA] border border-[#E3E8EF] px-4 py-2.5 text-xs text-[#5E718D] flex items-center gap-2">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin text-[#0C7C61]" />
                  <span>Reading your invoices …</span>
                </div>
              </div>
            )}

            {/* Error Banner */}
            {error && (
              <div className="p-3.5 rounded-2xl bg-[#FEF3F2] border border-[#FECDCA] text-[#B42318] text-xs flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{error}</span>
                </div>
                {lastQuestion && (
                  <button
                    type="button"
                    onClick={() => handleSendMessage(lastQuestion)}
                    className="px-2.5 py-1 rounded-lg bg-white border border-[#FECDCA] font-semibold text-[11px] text-[#B42318] hover:bg-[#FEE4E2] cursor-pointer"
                  >
                    Retry
                  </button>
                )}
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Guided Questions Control Bar (Replaces Free-Text Input) */}
          <div className="p-4 border-t border-[#E3E8EF] bg-[#FAF9F5] space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-[#12263F] flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-[#0C7C61]" />
                Select a question to ask Navi
              </span>
              {availableClients.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowClientSelector((prev) => !prev)}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                    showClientSelector
                      ? "bg-[#0C7C61] text-white border-[#0C7C61]"
                      : "bg-white text-[#5E718D] hover:text-[#12263F] border-[#E3E8EF]"
                  }`}
                >
                  <Users className="w-3 h-3" />
                  <span>Client summary</span>
                </button>
              )}
            </div>

            {/* Client Picker Drawer (When opened) */}
            {showClientSelector && availableClients.length > 0 && (
              <div className="p-3 bg-white rounded-xl border border-[#0C7C61]/30 shadow-2xs space-y-2 animate-in fade-in duration-150">
                <p className="text-[11px] font-medium text-[#5E718D]">
                  Select an actual client from your workspace records:
                </p>
                <div className="flex flex-wrap gap-2">
                  {availableClients.map((client) => (
                    <button
                      key={client.id || client.name}
                      type="button"
                      data-testid="client-option-btn"
                      onClick={() => handleSendMessage(`Summarize ${client.name}'s invoices`)}
                      disabled={isLoading}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#F6F5F1] hover:bg-[#E8F5F1] hover:text-[#0C7C61] border border-[#E3E8EF] text-xs font-medium text-[#12263F] transition-colors cursor-pointer disabled:opacity-50"
                    >
                      <span>Summarize {client.name}</span>
                      <span className="text-[10px] text-[#5E718D]">({client.invoiceCount})</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Core Guided Questions Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
              {activeGuidedQuestions.map((q) => (
                <button
                  key={q.text}
                  type="button"
                  onClick={() => handleSendMessage(q.text)}
                  disabled={isLoading}
                  className="flex items-center gap-2 p-2.5 rounded-xl bg-white hover:bg-[#F6F5F1] hover:border-[#0C7C61]/40 border border-[#E3E8EF] text-xs font-medium text-[#12263F] shadow-2xs transition-all hover:scale-[1.01] text-left cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed touch-target"
                >
                  <span className="shrink-0 p-1 rounded-md bg-[#F6F5F1]">{q.icon}</span>
                  <span className="truncate">{q.label}</span>
                </button>
              ))}
            </div>

            <p className="text-[11px] text-[#5E718D] text-center">
              Guided mode · Answers come strictly from verified PayPal Sandbox records and your invoices
            </p>
          </div>
        </div>

        {/* Right Column: "Ranked for you" Side Panel */}
        <div className="bg-white rounded-2xl border border-[#E3E8EF] p-5 shadow-xs space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-[#E3E8EF]">
            <div>
              <h2 className="font-bold text-sm text-[#12263F]">Ranked for you</h2>
              <p className="text-[11px] text-[#5E718D]">Deterministic rule-based order</p>
            </div>
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[#F6F5F1] text-[#5E718D] border border-[#E3E8EF]">
              {rankedInvoices.length} priority
            </span>
          </div>

          {rankedInvoices.length === 0 ? (
            <div className="text-center py-8 text-xs text-[#5E718D]">
              <ShieldCheck className="w-8 h-8 text-[#0C7C61] mx-auto mb-2" />
              <p className="font-medium text-[#12263F]">No receivables require follow-up</p>
              <p className="mt-1">All invoices are settled or awaiting payment without delay.</p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {rankedInvoices.map((inv) => (
                <Link
                  key={inv.invoiceId}
                  href={`/invoices/${inv.invoiceId}`}
                  className="group flex items-center justify-between p-3 rounded-xl border border-[#E3E8EF] bg-white hover:bg-[#F6F5F1] hover:border-[#0C7C61]/30 transition-colors shadow-2xs"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="flex items-center justify-center w-6 h-6 rounded-full bg-[#12263F] text-white text-xs font-bold shrink-0">
                      {inv.rank}
                    </span>
                    <div className="min-w-0">
                      <p className="font-semibold text-xs text-[#12263F] truncate group-hover:text-[#0C7C61] transition-colors">
                        {inv.clientName}
                      </p>
                      <p className="text-[10px] text-[#5E718D] font-mono">
                        {inv.invoiceNumber}
                      </p>
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <span className="inline-block px-2 py-0.5 rounded-md text-[10px] font-semibold bg-[#E8F5F1] text-[#0C7C61] border border-[#0C7C61]/20">
                      {inv.actionBadge} · {inv.formattedAmount}
                    </span>
                    <p className="text-[10px] text-[#B42318] font-medium mt-0.5">
                      {inv.daysText}
                    </p>
                  </div>
                </Link>
              ))}
            </div>
          )}

          {/* Explanation Callout */}
          <div className="p-3.5 rounded-xl bg-[#F6F5F1] border border-[#E3E8EF] text-[11px] text-[#5E718D] leading-relaxed flex items-start gap-2">
            <Info className="w-4 h-4 shrink-0 text-[#0C7C61] mt-0.5" />
            <span>
              Ranking is rule-based, so the same data always gives the same order. Overdue accounts with higher balances appear first.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
