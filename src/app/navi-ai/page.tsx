import React, { Suspense } from "react";
import { Metadata } from "next";
import { AppHeader } from "@/components/layout/app-header";
import { MobileNav } from "@/components/layout/mobile-nav";
import { AskNaviClient } from "@/components/navi/ask-navi-client";
import { getDashboardData } from "@/lib/services/dashboard.service";
import { requireAuth } from "@/lib/auth/server-session";
import { formatMoney } from "@/lib/money";
import { CashPilotStatus } from "@prisma/client";
import { AlertCircle, RefreshCw } from "lucide-react";
import type {
  RankedInvoiceItem,
  AvailableClientItem,
} from "@/lib/services/ask-navi.service";

export const metadata: Metadata = {
  title: "Ask Navi | CashPilot AI",
  description: "Guided conversational receivables copilot grounded in your verified invoices and PayPal Sandbox status.",
};

async function AskNaviContent() {
  const session = await requireAuth();
  const result = await getDashboardData(session.workspace.id, session.user.id);

  if (!result.ok) {
    return (
      <div className="flex-1 max-w-4xl mx-auto px-4 py-16 flex flex-col items-center justify-center text-center">
        <div className="p-5 rounded-2xl bg-[#FEF3F2] border border-[#FECDCA] text-[#B42318] max-w-md">
          <AlertCircle className="w-8 h-8 mx-auto mb-2" />
          <h2 className="font-semibold text-base mb-1">Unable to load workspace data</h2>
          <p className="text-xs text-[#5E718D]">{result.error}</p>
        </div>
      </div>
    );
  }

  const { workspace, invoices, lastSyncAt, hasStaleInvoices } = result.data;
  const now = new Date();

  // Compute available clients from database ground truth
  const clientMap = new Map<string, { id: string; name: string; invoiceCount: number }>();
  for (const inv of invoices) {
    const clientId = inv.client.id || inv.client.name;
    const existing = clientMap.get(clientId) || {
      id: clientId,
      name: inv.client.name,
      invoiceCount: 0,
    };
    existing.invoiceCount += 1;
    clientMap.set(clientId, existing);
  }
  const initialAvailableClients: AvailableClientItem[] = Array.from(clientMap.values()).sort(
    (a, b) => b.invoiceCount - a.invoiceCount
  );

  // Compute initial deterministic priority ranking
  const unpaidInvoices = invoices.filter(
    (inv) =>
      inv.cashpilotStatus === CashPilotStatus.OVERDUE ||
      inv.cashpilotStatus === CashPilotStatus.DUE_SOON ||
      inv.cashpilotStatus === CashPilotStatus.AWAITING_PAYMENT
  );

  const sortedByPriority = [...unpaidInvoices].sort((a, b) => {
    const aDue = typeof a.dueDate === "string" ? new Date(a.dueDate) : a.dueDate;
    const bDue = typeof b.dueDate === "string" ? new Date(b.dueDate) : b.dueDate;
    const aDays = Math.max(0, Math.floor((now.getTime() - aDue.getTime()) / (1000 * 60 * 60 * 24)));
    const bDays = Math.max(0, Math.floor((now.getTime() - bDue.getTime()) / (1000 * 60 * 60 * 24)));

    if (aDays !== bDays) return bDays - aDays;
    return b.totalMinorUnits - a.totalMinorUnits;
  });

  const initialRankedInvoices: RankedInvoiceItem[] = sortedByPriority.slice(0, 5).map((inv, idx) => {
    const due = typeof inv.dueDate === "string" ? new Date(inv.dueDate) : inv.dueDate;
    const days = Math.max(0, Math.floor((now.getTime() - due.getTime()) / (1000 * 60 * 60 * 24)));
    let actionBadge = "Review";
    if (inv.cashpilotStatus === CashPilotStatus.OVERDUE) actionBadge = "Remind";
    else if (inv.cashpilotStatus === CashPilotStatus.DUE_SOON) actionBadge = "Heads-up";
    else if (inv.syncIsStale) actionBadge = "Refresh status";

    return {
      rank: idx + 1,
      clientName: inv.client.name,
      invoiceNumber: inv.number ?? "Draft",
      invoiceId: inv.id,
      formattedAmount: formatMoney(inv.totalMinorUnits, inv.currency),
      daysText: days > 0 ? `${days}d` : "due soon",
      actionBadge,
      status: inv.cashpilotStatus,
    };
  });

  const isSameDay = (d1: Date | string, d2: Date) => {
    const date1 = typeof d1 === "string" ? new Date(d1) : d1;
    return (
      (date1.getFullYear() === d2.getFullYear() &&
        date1.getMonth() === d2.getMonth() &&
        date1.getDate() === d2.getDate()) ||
      (date1.getUTCFullYear() === d2.getUTCFullYear() &&
        date1.getUTCMonth() === d2.getUTCMonth() &&
        date1.getUTCDate() === d2.getUTCDate())
    );
  };

  const initialDataCounts = {
    total: invoices.length,
    overdue: invoices.filter((i) => i.cashpilotStatus === CashPilotStatus.OVERDUE).length,
    unpaid: unpaidInvoices.length,
    paid: invoices.filter((i) => i.cashpilotStatus === CashPilotStatus.PAID).length,
    dueToday: invoices.filter(
      (i) =>
        isSameDay(i.dueDate, now) &&
        i.cashpilotStatus !== CashPilotStatus.PAID &&
        i.cashpilotStatus !== CashPilotStatus.CANCELLED
    ).length,
    dueSoon: invoices.filter((i) => i.cashpilotStatus === CashPilotStatus.DUE_SOON).length,
  };

  return (
    <>
      <AppHeader
        workspaceName={workspace.name}
        isDemo={workspace.isDemo}
        user={session.user}
        lastSyncAt={lastSyncAt}
        hasStaleInvoices={hasStaleInvoices}
      />

      <main className="flex-1 pb-16 md:pb-10">
        <AskNaviClient
          initialRankedInvoices={initialRankedInvoices}
          lastSyncAt={lastSyncAt}
          initialAvailableClients={initialAvailableClients}
          initialDataCounts={initialDataCounts}
        />
      </main>

      <MobileNav />
    </>
  );
}

export default function AskNaviPage() {
  return (
    <div className="min-h-screen flex flex-col bg-[#FDFCFB]">
      <Suspense
        fallback={
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-xs text-[#5E718D]">
            <RefreshCw className="w-6 h-6 animate-spin text-[#0C7C61] mb-2" />
            <p>Loading Ask Navi...</p>
          </div>
        }
      >
        <AskNaviContent />
      </Suspense>
    </div>
  );
}
