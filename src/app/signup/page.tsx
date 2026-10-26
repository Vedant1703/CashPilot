import React, { Suspense } from "react";
import { Metadata } from "next";
import { redirect } from "next/navigation";
import { CashPilotLogo } from "@/components/brand/cashpilot-logo";
import { SignupForm } from "@/components/auth/signup-form";
import { getCurrentSession } from "@/lib/auth/server-session";

export const metadata: Metadata = {
  title: "Create an Account | CashPilot",
  description: "Create your CashPilot account and get your dedicated receivables workspace.",
};

async function SignupContent() {
  const session = await getCurrentSession();
  if (session && session.workspace) {
    redirect("/");
  }

  return (
    <div className="w-full max-w-md flex flex-col items-center space-y-6">
      <div className="flex flex-col items-center">
        <CashPilotLogo size={42} showText={true} showTagline={true} />
      </div>

      <SignupForm />

      <p className="text-center text-xs text-[#94A3B8]">
        Protected by CashPilot cryptographic session authentication
      </p>
    </div>
  );
}

export default function SignupPage() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-4 sm:p-6 bg-[#F6F5F1]">
      <Suspense fallback={<div className="w-full max-w-md h-96 bg-white/50 rounded-2xl animate-pulse" />}>
        <SignupContent />
      </Suspense>
    </main>
  );
}
