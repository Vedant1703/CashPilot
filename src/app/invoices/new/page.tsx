import React, { Suspense } from "react";
import { Metadata } from "next";
import { AppHeader } from "@/components/layout/app-header";
import { MobileNav } from "@/components/layout/mobile-nav";
import { StudioWizard } from "@/components/studio/studio-wizard";
import { db } from "@/lib/db/client";
import { requireAuth } from "@/lib/auth/server-session";

export const metadata: Metadata = {
  title: "AI Invoice Studio | CashPilot",
  description: "Natural-language invoice drafting, deterministic validation, human approval, and PayPal Sandbox draft creation.",
};

async function StudioContent() {
  const session = await requireAuth();

  const clients = await db.client.findMany({
    where: { workspaceId: session.workspace.id },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      email: true,
      company: true,
    },
  });

  return (
    <>
      <AppHeader
        workspaceName={session.workspace.name}
        isDemo={session.workspace.isDemo}
        user={session.user}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        <StudioWizard knownClients={clients} />
      </main>
    </>
  );
}

function StudioLoadingFallback() {
  return (
    <div className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 animate-pulse">
      <div className="h-10 w-48 bg-[#E3E8EF] rounded-xl mb-6" />
      <div className="h-64 w-full bg-white rounded-2xl border border-[#E3E8EF]" />
    </div>
  );
}

export default function NewInvoiceStudioPage() {
  return (
    <div className="min-h-screen flex flex-col bg-[#F6F5F1] text-[#12263F] pb-16 md:pb-8">
      <Suspense fallback={<StudioLoadingFallback />}>
        <StudioContent />
      </Suspense>

      <MobileNav />
    </div>
  );
}
