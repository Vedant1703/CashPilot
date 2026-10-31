import React, { Suspense } from "react";
import { Metadata } from "next";
import { AppHeader } from "@/components/layout/app-header";
import { MobileNav } from "@/components/layout/mobile-nav";
import { ActivityFeed } from "@/components/activity/activity-feed";
import { ActivitySkeleton } from "@/components/activity/activity-skeleton";
import { requireAuth } from "@/lib/auth/server-session";
import {
  getWorkspaceActivityFeed,
  getInvoiceEndToEndTrace,
  getWorkspaceInvoicesForActivitySelector,
  type ActivityFilterOptions,
} from "@/lib/services/activity.service";
import { AlertCircle } from "lucide-react";

export const metadata: Metadata = {
  title: "Activity & Audit History | CashPilot AI",
  description:
    "A permanent append-only record of what was proposed, approved and confirmed in PayPal Sandbox.",
};

interface ActivityPageProps {
  searchParams: Promise<{
    invoiceId?: string;
    type?: string;
    result?: string;
    search?: string;
  }>;
}

async function ActivityContent({ searchParams }: ActivityPageProps) {
  const session = await requireAuth();
  const params = await searchParams;

  const invoiceId = params.invoiceId;
  const filterOptions: ActivityFilterOptions = {
    invoiceId,
    search: params.search,
    limit: 50,
  };

  if (
    params.type &&
    ["all", "ai", "approval", "operation", "sync", "security"].includes(params.type)
  ) {
    filterOptions.type = params.type as ActivityFilterOptions["type"];
  }

  if (
    params.result &&
    ["all", "confirmed", "approved", "proposed", "partial", "rejected", "unknown"].includes(
      params.result
    )
  ) {
    filterOptions.result = params.result as ActivityFilterOptions["result"];
  }

  let feedResult = null;
  let selectorOptions: Awaited<ReturnType<typeof getWorkspaceInvoicesForActivitySelector>> = [];
  let trace = null;
  let loadError: string | null = null;

  try {
    const [fetchedFeed, fetchedSelectors] = await Promise.all([
      getWorkspaceActivityFeed(session.workspace.id, session.user.id, filterOptions),
      getWorkspaceInvoicesForActivitySelector(session.workspace.id),
    ]);

    feedResult = fetchedFeed;
    selectorOptions = fetchedSelectors;

    const targetInvoiceId = invoiceId || selectorOptions[0]?.id;
    if (targetInvoiceId) {
      trace = await getInvoiceEndToEndTrace(session.workspace.id, targetInvoiceId);
    }
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Unable to retrieve activity events";
  }

  if (loadError || !feedResult) {
    return (
      <>
        <AppHeader
          workspaceName={session.workspace.name}
          isDemo={session.workspace.isDemo}
          user={session.user}
        />

        <main className="flex-1 max-w-4xl mx-auto px-4 py-16 flex flex-col items-center justify-center text-center">
          <div className="p-5 rounded-2xl bg-[#FEF3F2] border border-[#FECDCA] text-[#B42318] max-w-md space-y-2">
            <AlertCircle className="w-8 h-8 mx-auto" />
            <h2 className="font-semibold text-base">Failed to load activity log</h2>
            <p className="text-xs text-[#5E718D]">{loadError}</p>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <AppHeader
        workspaceName={session.workspace.name}
        isDemo={session.workspace.isDemo}
        user={session.user}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        <ActivityFeed
          initialItems={feedResult.items}
          initialTrace={trace}
          selectorOptions={selectorOptions}
          workspaceId={session.workspace.id}
          initialInvoiceId={invoiceId}
        />
      </main>
    </>
  );
}

function ActivityLoadingShell() {
  return (
    <>
      <AppHeader />
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        <ActivitySkeleton />
      </main>
    </>
  );
}

export default function ActivityPage({ searchParams }: ActivityPageProps) {
  return (
    <div className="min-h-screen flex flex-col bg-[#F6F5F1] text-[#12263F] pb-16 md:pb-8">
      <Suspense fallback={<ActivityLoadingShell />}>
        <ActivityContent searchParams={searchParams} />
      </Suspense>

      {/* Mobile Bottom Navigation Bar */}
      <MobileNav />
    </div>
  );
}
