import React, { Suspense } from "react";
import Link from "next/link";
import { AppHeader } from "@/components/layout/app-header";
import { MobileNav } from "@/components/layout/mobile-nav";
import { NaviGreeting } from "@/components/dashboard/navi-greeting";
import { MetricCard } from "@/components/dashboard/metric-card";
import { StageBreakdown } from "@/components/dashboard/stage-breakdown";
import { RecentActivity } from "@/components/dashboard/recent-activity";
import { DashboardSkeleton } from "@/components/dashboard/dashboard-skeleton";
import { getDashboardData } from "@/lib/services/dashboard.service";
import { requireAuth } from "@/lib/auth/server-session";
import {
  Sparkles,
  ArrowRight,
  AlertCircle,
  ShieldCheck,
} from "lucide-react";

async function DashboardContent() {
  const session = await requireAuth();
  const result = await getDashboardData(session.workspace.id, session.user.id);

  if (!result.ok) {
    return (
      <>
        <AppHeader
          workspaceName={session.workspace.name}
          isDemo={session.workspace.isDemo}
          user={session.user}
        />
        <main className="flex-1 max-w-4xl mx-auto px-4 py-16 flex flex-col items-center justify-center text-center">
          <div className="p-5 rounded-2xl bg-[#FEF3F2] border border-[#FECDCA] text-[#B42318] max-w-md">
            <AlertCircle className="w-8 h-8 mx-auto mb-2" />
            <h2 className="font-semibold text-base mb-1">Failed to load dashboard data</h2>
            <p className="text-xs text-[#5E718D]">{result.error}</p>
          </div>
        </main>
      </>
    );
  }

  const { workspace, metrics, collections, recentActivities, lastSyncAt, hasStaleInvoices } = result.data;
  const overdueInvoices = collections.columns.overdue;
  const dueSoonInvoices = collections.columns.dueSoon;

  return (
    <>
      <AppHeader
        workspaceName={workspace.name}
        isDemo={workspace.isDemo}
        user={session.user}
        lastSyncAt={lastSyncAt}
        hasStaleInvoices={hasStaleInvoices}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6 sm:space-y-8">
        {/* Navi Greeting Callout */}
        <NaviGreeting
          headline={metrics.naviGreeting.headline}
          body={metrics.naviGreeting.body}
          actionRequiredCount={metrics.naviGreeting.actionRequiredCount}
          primaryActionLabel={metrics.naviGreeting.primaryActionLabel}
          primaryActionHref={metrics.naviGreeting.primaryActionHref}
        />

        {/* Receivables Four Core Metric Cards */}
        <section aria-label="Receivables Metrics">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <MetricCard metric={metrics.outstanding} />
            <MetricCard metric={metrics.overdue} />
            <MetricCard metric={metrics.dueSoon} />
            <MetricCard metric={metrics.paidThisMonth} />
          </div>
        </section>

        {/* Two-Column Mid-Section: Next Best Actions & Stage Breakdown */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Next Best Actions (AI Proposed) — 7 cols */}
          <section
            aria-label="Recommended Collection Actions"
            className="lg:col-span-7 rounded-2xl bg-white border border-[#E3E8EF] p-5 sm:p-6 shadow-xs space-y-4"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="p-1 rounded-lg bg-[#F0EEFF] text-[#5B3FD0] border border-[#CDC4FF]">
                  <Sparkles className="w-4 h-4" />
                </span>
                <div>
                  <h3 className="font-semibold text-sm text-[#12263F]">
                    Next Best Actions
                  </h3>
                  <p className="text-xs text-[#5E718D]">
                    AI-prioritized follow-ups grounded in persisted invoice facts
                  </p>
                </div>
              </div>

              <span className="text-[11px] font-mono font-medium text-[#5B3FD0] px-2 py-0.5 rounded-full bg-[#F0EEFF] border border-[#CDC4FF]">
                ✦ Proactive
              </span>
            </div>

            {overdueInvoices.length === 0 && dueSoonInvoices.length === 0 ? (
              <div className="text-center py-8 rounded-xl bg-[#F6F5F1]/60 border border-[#E3E8EF] p-4 text-xs text-[#5E718D] space-y-1">
                <ShieldCheck className="w-6 h-6 text-[#0C7C61] mx-auto" />
                <p className="font-medium text-[#12263F]">All sent receivables are on track</p>
                <p>No client reminders are currently needed today.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {/* Overdue Priority Action */}
                {overdueInvoices.map((inv) => (
                  <div
                    key={inv.id}
                    className="p-4 rounded-xl border border-[#FECDCA] bg-[#FEF3F2]/40 hover:bg-[#FEF3F2]/70 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#B42318]">
                          <span>●</span>
                          <span>Overdue Follow-up</span>
                        </span>
                        <span className="text-[#5E718D] text-xs">·</span>
                        <span className="font-mono text-xs text-[#12263F] font-semibold">
                          {inv.number ?? inv.id.slice(0, 8)}
                        </span>
                      </div>
                      <p className="text-xs font-medium text-[#12263F]">
                        {inv.client.name} — {(inv.totalMinorUnits / 100).toFixed(2)} {inv.currency}
                      </p>
                      <p className="text-[11px] text-[#5E718D]">
                        Due date was {new Date(inv.dueDate).toLocaleDateString([], { month: "short", day: "numeric" })}. PayPal status is SENT.
                      </p>
                    </div>

                    <Link
                      href={`/invoices/${inv.id}`}
                      className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-[#B4440B] hover:bg-[#963809] text-white text-xs font-semibold shadow-xs transition-colors shrink-0 touch-target"
                    >
                      <span>Review reminder</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </Link>
                  </div>
                ))}

                {/* Due Soon Priority Action */}
                {dueSoonInvoices.map((inv) => (
                  <div
                    key={inv.id}
                    className="p-4 rounded-xl border border-[#F3E0A2] bg-[#FEF9E7]/40 hover:bg-[#FEF9E7]/70 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#7A5600]">
                          <span>◷</span>
                          <span>Approaching Due Date</span>
                        </span>
                        <span className="text-[#5E718D] text-xs">·</span>
                        <span className="font-mono text-xs text-[#12263F] font-semibold">
                          {inv.number ?? inv.id.slice(0, 8)}
                        </span>
                      </div>
                      <p className="text-xs font-medium text-[#12263F]">
                        {inv.client.name} — {(inv.totalMinorUnits / 100).toFixed(2)} {inv.currency}
                      </p>
                      <p className="text-[11px] text-[#5E718D]">
                        Due on {new Date(inv.dueDate).toLocaleDateString([], { month: "short", day: "numeric" })}. Payment tracking active.
                      </p>
                    </div>

                    <Link
                      href={`/invoices/${inv.id}`}
                      className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border border-[#E3E8EF] bg-white hover:bg-[#F6F5F1] text-[#12263F] text-xs font-semibold shadow-xs transition-colors shrink-0 touch-target"
                    >
                      <span>View details</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </Link>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Outstanding by Stage Breakdown — 5 cols */}
          <section aria-label="Receivables by Stage" className="lg:col-span-5">
            <StageBreakdown breakdown={metrics.stageBreakdown} />
          </section>
        </div>

        {/* Recent Audit & Activity Trail */}
        <section aria-label="Activity Trail">
          <RecentActivity activities={recentActivities} />
        </section>
      </main>
    </>
  );
}

function DashboardLoadingShell() {
  return (
    <>
      <AppHeader />
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <DashboardSkeleton />
      </main>
    </>
  );
}

export default function DashboardPage() {
  return (
    <div className="min-h-screen flex flex-col bg-[#F6F5F1] text-[#12263F] pb-16 md:pb-8">
      <Suspense fallback={<DashboardLoadingShell />}>
        <DashboardContent />
      </Suspense>

      {/* Mobile Bottom Navigation Bar */}
      <MobileNav />
    </div>
  );
}
