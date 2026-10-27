import React, { Suspense } from "react";
import { Metadata } from "next";
import { AppHeader } from "@/components/layout/app-header";
import { MobileNav } from "@/components/layout/mobile-nav";
import { ClientDirectory } from "@/components/clients/client-directory";
import { requireAuth } from "@/lib/auth/server-session";

export const metadata: Metadata = {
  title: "Clients | CashPilot",
  description: "Manage client directory, contact information, and billing recipients in your workspace.",
};

async function ClientsContent() {
  const session = await requireAuth();

  return (
    <>
      <AppHeader
        workspaceName={session.workspace.name}
        isDemo={session.workspace.isDemo}
        user={session.user}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        <ClientDirectory />
      </main>
    </>
  );
}

function ClientsLoadingFallback() {
  return (
    <div className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 animate-pulse space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <div className="h-8 w-40 bg-[#E3E8EF] rounded-xl" />
          <div className="h-4 w-64 bg-[#EEF2F6] rounded" />
        </div>
        <div className="h-10 w-28 bg-[#E3E8EF] rounded-xl" />
      </div>
      <div className="h-12 w-full bg-white rounded-2xl border border-[#E3E8EF]" />
      <div className="h-64 w-full bg-white rounded-2xl border border-[#E3E8EF]" />
    </div>
  );
}

export default function ClientsPage() {
  return (
    <div className="min-h-screen flex flex-col bg-[#F6F5F1] text-[#12263F] pb-16 md:pb-8">
      <Suspense fallback={<ClientsLoadingFallback />}>
        <ClientsContent />
      </Suspense>

      <MobileNav />
    </div>
  );
}
