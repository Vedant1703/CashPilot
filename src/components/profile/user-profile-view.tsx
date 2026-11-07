"use client";

import React, { useState } from "react";
import {
  User,
  Mail,
  Building,
  Shield,
  Calendar,
  CheckCircle2,
  AlertCircle,
  Loader2,
  FileText,
  Users,
} from "lucide-react";

export interface UserProfileData {
  user: {
    id: string;
    name: string;
    email: string;
    createdAt: string | Date;
    updatedAt: string | Date;
  };
  workspace: {
    id: string;
    name: string;
    isDemo: boolean;
    invoiceCount: number;
    clientCount: number;
  } | null;
}

interface UserProfileViewProps {
  initialData: UserProfileData;
}

export function UserProfileView({ initialData }: UserProfileViewProps) {
  const [name, setName] = useState(initialData.user.name);
  const [email, setEmail] = useState(initialData.user.email);
  const [isSaving, setIsSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const initials = name
    .split(" ")
    .map((n) => n[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase() || "CP";

  const memberSince = new Date(initialData.user.createdAt).toLocaleDateString([], {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);

    const trimmedName = name.trim();
    const trimmedEmail = email.trim();

    if (trimmedName.length < 2) {
      setErrorMessage("Name must be at least 2 characters.");
      return;
    }
    if (!trimmedEmail.includes("@")) {
      setErrorMessage("Please enter a valid email address.");
      return;
    }

    setIsSaving(true);
    try {
      const res = await fetch("/api/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmedName, email: trimmedEmail }),
      });

      const json = await res.json();
      if (res.ok && json.success) {
        setSuccessMessage("Profile updated successfully.");
        setTimeout(() => setSuccessMessage(null), 4000);
      } else {
        setErrorMessage(json.error || "Failed to update profile.");
      }
    } catch {
      setErrorMessage("Network error while saving profile.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header */}
      <div>
        <h1 className="font-headline font-bold text-2xl sm:text-3xl text-[#12263F] tracking-tight">
          Account Profile
        </h1>
        <p className="text-xs sm:text-sm text-[#5E718D] mt-1">
          Manage your personal details and view your workspace authorization settings.
        </p>
      </div>

      {/* Notifications */}
      {successMessage && (
        <div
          role="status"
          className="p-4 rounded-xl bg-[#E8F5F1] border border-[#A3E5D4] text-[#0C7C61] text-xs sm:text-sm flex items-center justify-between gap-3 animate-in fade-in"
        >
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 shrink-0" />
            <span className="font-medium">{successMessage}</span>
          </div>
          <button
            type="button"
            onClick={() => setSuccessMessage(null)}
            className="text-xs font-semibold text-[#0C7C61] hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {errorMessage && (
        <div
          role="alert"
          className="p-4 rounded-xl bg-[#FEF3F2] border border-[#FECDCA] text-[#B42318] text-xs sm:text-sm flex items-center justify-between gap-3 animate-in fade-in"
        >
          <div className="flex items-center gap-2">
            <AlertCircle className="w-5 h-5 shrink-0" />
            <span className="font-medium">{errorMessage}</span>
          </div>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            className="text-xs font-semibold text-[#B42318] hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Grid: Profile Card & Workspace Binding */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Editable Profile Form (7 cols) */}
        <div className="lg:col-span-7 rounded-2xl bg-white border border-[#E3E8EF] p-6 shadow-xs space-y-6">
          {/* Identity Header */}
          <div className="flex items-center gap-4 pb-5 border-b border-[#EEF2F6]">
            <div className="w-14 h-14 rounded-2xl bg-[#0C7C61] text-white flex items-center justify-center font-bold text-xl shadow-xs shrink-0">
              {initials}
            </div>
            <div className="space-y-0.5 min-w-0">
              <h2 className="text-base font-bold text-[#12263F] truncate">{name}</h2>
              <p className="text-xs text-[#5E718D] font-mono truncate">{email}</p>
              <div className="flex items-center gap-2 pt-1 text-[11px] text-[#8A9BA8]">
                <Calendar className="w-3.5 h-3.5" />
                <span>Member since {memberSince}</span>
              </div>
            </div>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="profile-name" className="block text-xs font-semibold text-[#12263F]">
                Display Name
              </label>
              <div className="relative">
                <User className="w-4 h-4 text-[#8A9BA8] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="profile-name"
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={isSaving}
                  placeholder="Your full name"
                  className="w-full pl-9 pr-3.5 py-2.5 rounded-xl border border-[#E3E8EF] text-xs sm:text-sm bg-[#F6F5F1]/30 focus:border-[#0C7C61] focus:ring-1 focus:ring-[#0C7C61] focus:outline-hidden transition-colors"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="profile-email" className="block text-xs font-semibold text-[#12263F]">
                Email Address
              </label>
              <div className="relative">
                <Mail className="w-4 h-4 text-[#8A9BA8] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="profile-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={isSaving}
                  placeholder="your.email@example.com"
                  className="w-full pl-9 pr-3.5 py-2.5 rounded-xl border border-[#E3E8EF] text-xs sm:text-sm bg-[#F6F5F1]/30 focus:border-[#0C7C61] focus:ring-1 focus:ring-[#0C7C61] focus:outline-hidden transition-colors"
                />
              </div>
              <p className="text-[11px] text-[#8A9BA8]">
                Used for account sign-in and system notifications.
              </p>
            </div>

            <div className="pt-3 border-t border-[#EEF2F6] flex justify-end">
              <button
                type="submit"
                id="save-profile-btn"
                disabled={isSaving}
                className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-[#0C7C61] hover:bg-[#09634E] text-white text-xs sm:text-sm font-semibold shadow-xs transition-colors disabled:opacity-50 min-h-[44px] touch-target focus-visible:ring-2 focus-visible:ring-[#0C7C61]"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Saving changes...</span>
                  </>
                ) : (
                  <span>Save Profile</span>
                )}
              </button>
            </div>
          </form>
        </div>

        {/* Right Column: Workspace & Account Details (5 cols) */}
        <div className="lg:col-span-5 space-y-6">
          {/* Workspace Binding Card */}
          {initialData.workspace && (
            <div className="rounded-2xl bg-white border border-[#E3E8EF] p-6 shadow-xs space-y-4">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[#5E718D]">
                <Building className="w-4 h-4 text-[#0C7C61]" />
                <span>Primary Workspace</span>
              </div>

              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <h3 className="font-bold text-base text-[#12263F]">
                    {initialData.workspace.name}
                  </h3>
                  {initialData.workspace.isDemo && (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-[#34C79F]/20 text-[#0C7C61] border border-[#34C79F]/40 font-mono">
                      DEMO
                    </span>
                  )}
                </div>
                <p className="text-xs text-[#5E718D]">
                  Role: <span className="font-semibold text-[#12263F]">Workspace Owner</span>
                </p>
              </div>

              {/* Workspace Quick Stats */}
              <div className="grid grid-cols-2 gap-3 pt-2">
                <div className="p-3 rounded-xl bg-[#F6F5F1] border border-[#E3E8EF] text-center">
                  <div className="flex items-center justify-center gap-1.5 text-xs text-[#5E718D] mb-1">
                    <FileText className="w-3.5 h-3.5 text-[#0C7C61]" />
                    <span>Invoices</span>
                  </div>
                  <span className="font-mono font-bold text-base text-[#12263F]">
                    {initialData.workspace.invoiceCount}
                  </span>
                </div>

                <div className="p-3 rounded-xl bg-[#F6F5F1] border border-[#E3E8EF] text-center">
                  <div className="flex items-center justify-center gap-1.5 text-xs text-[#5E718D] mb-1">
                    <Users className="w-3.5 h-3.5 text-[#0C7C61]" />
                    <span>Clients</span>
                  </div>
                  <span className="font-mono font-bold text-base text-[#12263F]">
                    {initialData.workspace.clientCount}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Security & Invariants Card */}
          <div className="rounded-2xl bg-white border border-[#E3E8EF] p-6 shadow-xs space-y-3">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[#5E718D]">
              <Shield className="w-4 h-4 text-[#0C7C61]" />
              <span>Security & Environment</span>
            </div>

            <div className="text-xs space-y-2 text-[#5E718D] leading-relaxed">
              <div className="flex justify-between py-1 border-b border-[#EEF2F6]">
                <span>Provider:</span>
                <span className="font-semibold text-[#12263F]">PayPal Sandbox</span>
              </div>
              <div className="flex justify-between py-1 border-b border-[#EEF2F6]">
                <span>User Identifier:</span>
                <span className="font-mono text-[11px] text-[#12263F]">
                  {initialData.user.id.slice(0, 12)}...
                </span>
              </div>
              <div className="flex justify-between py-1">
                <span>Session Protection:</span>
                <span className="font-medium text-[#0C7C61]">HTTP-Only Secure</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

