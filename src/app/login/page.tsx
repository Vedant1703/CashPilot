import React, { Suspense } from "react";
import { Metadata } from "next";
import { redirect } from "next/navigation";
import { CashPilotLogo } from "@/components/brand/cashpilot-logo";
import { LoginForm } from "@/components/auth/login-form";
import { getCurrentSession } from "@/lib/auth/server-session";

export const metadata: Metadata = {
  title: "Sign In | CashPilot",
  description: "Sign in to your CashPilot account to manage your receivables and intelligent collections.",
};

async function LoginContent() {
  const session = await getCurrentSession();
  if (session && session.workspace) {
    redirect("/");
  }

  return (
    <div className="w-full max-w-md flex flex-col items-center space-y-6">
      <div className="flex flex-col items-center">
        <CashPilotLogo size={42} showText={true} showTagline={true} />
      </div>

      <LoginForm />

      <p className="text-center text-xs text-[#94A3B8]">
        Protected by CashPilot cryptographic session authentication
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-4 sm:p-6 bg-[#F6F5F1]">
      <Suspense fallback={<div className="w-full max-w-md h-96 bg-white/50 rounded-2xl animate-pulse" />}>
        <LoginContent />
      </Suspense>
    </main>
  );
}
