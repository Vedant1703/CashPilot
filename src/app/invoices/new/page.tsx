import React, { Suspense } from "react";
import { Metadata } from "next";
import { AppHeader } from "@/components/layout/app-header";
import { MobileNav } from "@/components/layout/mobile-nav";
import { StudioWizard } from "@/components/studio/studio-wizard";
import { db } from "@/lib/db/client";

export const metadata: Metadata = {
  title: "AI Invoice Studio | CashPilot",
  description: "Natural-language invoice drafting, deterministic validation, human approval, and PayPal Sandbox draft creation.",
};

async function StudioContent() {
  // Fetch available workspace clients
  let clients: Array<{ id: string; name: string; email: string; company?: string | null }> = [];
  try {
    const fetchedClients = await db.client.findMany({
      where: { workspaceId: "demo-workspace-1" },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        email: true,
        company: true,
      },
    });
    clients = fetchedClients;
  } catch (err) {
    console.error("Failed to fetch clients for studio:", err);
    // Fallback safe demo client
    clients = [
      {
        id: "demo-client-1",
        name: "Acme Corp",
        email: "billing@acmecorp.com",
        company: "Acme Corporation",
      },
      {
        id: "demo-client-2",
        name: "TechStart Inc",
        email: "ap@techstart.io",
        company: "TechStart",
      },
    ];
  }

  return (
    <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
      <StudioWizard knownClients={clients} />
    </main>
  );
}

function StudioLoadingShell() {
  return (
    <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 animate-pulse space-y-6">
      <div className="h-6 w-48 bg-[#E3E8EF] rounded-md" />
      <div className="h-64 w-full bg-white border border-[#E3E8EF] rounded-2xl" />
    </main>
  );
}

export default function NewInvoiceStudioPage() {
  return (
    <div className="min-h-screen flex flex-col bg-[#F6F5F1] text-[#12263F] pb-16 md:pb-8">
      <AppHeader />

      <Suspense fallback={<StudioLoadingShell />}>
        <StudioContent />
      </Suspense>

      <MobileNav />
    </div>
  );
}
