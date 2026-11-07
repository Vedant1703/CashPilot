import React, { Suspense } from "react";
import { Metadata } from "next";
import { AppHeader } from "@/components/layout/app-header";
import { MobileNav } from "@/components/layout/mobile-nav";
import { UserProfileView, UserProfileData } from "@/components/profile/user-profile-view";
import { requireAuth } from "@/lib/auth/server-session";
import { db } from "@/lib/db/client";

export const metadata: Metadata = {
  title: "Account Profile | CashPilot",
  description: "Manage your CashPilot user profile, email address, and workspace settings.",
};

async function ProfileContent() {
  const session = await requireAuth();

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      name: true,
      email: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!user) {
    throw new Error("User record not found");
  }

  const [invoiceCount, clientCount] = await Promise.all([
    db.invoice.count({ where: { workspaceId: session.workspace.id } }),
    db.client.count({ where: { workspaceId: session.workspace.id } }),
  ]);

  const initialData: UserProfileData = {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    },
    workspace: {
      id: session.workspace.id,
      name: session.workspace.name,
      isDemo: session.workspace.isDemo,
      invoiceCount,
      clientCount,
    },
  };

  return (
    <>
      <AppHeader
        workspaceName={session.workspace.name}
        isDemo={session.workspace.isDemo}
        user={session.user}
      />
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        <UserProfileView initialData={initialData} />
      </main>
      <MobileNav />
    </>
  );
}

function ProfileLoadingFallback() {
  return (
    <div className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 animate-pulse space-y-6">
      <div className="space-y-2">
        <div className="h-8 w-44 bg-[#E3E8EF] rounded-xl" />
        <div className="h-4 w-72 bg-[#EEF2F6] rounded" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 h-80 bg-white rounded-2xl border border-[#E3E8EF]" />
        <div className="lg:col-span-5 h-80 bg-white rounded-2xl border border-[#E3E8EF]" />
      </div>
    </div>
  );
}

export default function ProfilePage() {
  return (
    <div className="min-h-screen flex flex-col bg-[#F6F5F1] text-[#12263F] pb-16 md:pb-8">
      <Suspense fallback={<ProfileLoadingFallback />}>
        <ProfileContent />
      </Suspense>
    </div>
  );
}
