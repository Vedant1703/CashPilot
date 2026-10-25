"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertCircle, ArrowRight, Building2, Loader2, Lock, Mail, User, Eye, EyeOff } from "lucide-react";

export function SignupForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;

    setError(null);

    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    const trimmedBusiness = businessName.trim();

    if (!trimmedName || trimmedName.length < 2) {
      setError("Please enter your full name (at least 2 characters).");
      return;
    }

    if (!trimmedEmail) {
      setError("Please enter your email address.");
      return;
    }

    if (!password || password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
      setError("Password must contain uppercase, lowercase, a number, and a special character.");
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          email: trimmedEmail,
          password,
          businessName: trimmedBusiness || undefined,
        }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok || !data?.success) {
        setError(data?.error || "Registration failed. Please check your information.");
        setLoading(false);
        return;
      }

      // Successful registration -> navigate to new empty workspace dashboard
      router.push("/");
      router.refresh();
    } catch {
      setError("An unexpected network error occurred. Please try again.");
      setLoading(false);
    }
  };

  return (
    <div className="w-full max-w-md bg-white border border-[#E3E8EF] rounded-2xl shadow-sm p-6 sm:p-8 space-y-6">
      <div className="space-y-1.5 text-center">
        <h1 className="font-headline text-2xl font-semibold tracking-tight text-[#12263F]">
          Create your account
        </h1>
        <p className="text-xs sm:text-sm text-[#5E718D]">
          Start managing receivables and intelligent collections
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="p-3.5 rounded-xl bg-[#FEF3F2] border border-[#FECDCA] text-[#B42318] text-xs flex items-start gap-2.5 animate-fadeIn"
        >
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="leading-relaxed">{error}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        {/* Full Name */}
        <div className="space-y-1.5">
          <label
            htmlFor="name"
            className="block text-xs font-semibold uppercase tracking-wider text-[#5E718D]"
          >
            Your Full Name
          </label>
          <div className="relative">
            <User className="w-4 h-4 text-[#94A3B8] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              id="name"
              name="name"
              type="text"
              autoComplete="name"
              required
              disabled={loading}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jane Doe"
              className="w-full pl-10 pr-3.5 py-2.5 rounded-xl border border-[#CBD5E1] bg-white text-[#12263F] text-sm focus:border-[#0C7C61] focus:ring-2 focus:ring-[#0C7C61]/20 outline-none transition-all placeholder:text-[#94A3B8] disabled:opacity-60"
            />
          </div>
        </div>

        {/* Email Address */}
        <div className="space-y-1.5">
          <label
            htmlFor="email"
            className="block text-xs font-semibold uppercase tracking-wider text-[#5E718D]"
          >
            Work Email
          </label>
          <div className="relative">
            <Mail className="w-4 h-4 text-[#94A3B8] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              disabled={loading}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="jane@yourstudio.com"
              className="w-full pl-10 pr-3.5 py-2.5 rounded-xl border border-[#CBD5E1] bg-white text-[#12263F] text-sm focus:border-[#0C7C61] focus:ring-2 focus:ring-[#0C7C61]/20 outline-none transition-all placeholder:text-[#94A3B8] disabled:opacity-60"
            />
          </div>
        </div>

        {/* Business Name */}
        <div className="space-y-1.5">
          <label
            htmlFor="businessName"
            className="block text-xs font-semibold uppercase tracking-wider text-[#5E718D]"
          >
            Business / Studio Name <span className="text-[#94A3B8] font-normal normal-case">(optional)</span>
          </label>
          <div className="relative">
            <Building2 className="w-4 h-4 text-[#94A3B8] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              id="businessName"
              name="businessName"
              type="text"
              autoComplete="organization"
              disabled={loading}
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              placeholder="Jane Doe Design Studio"
              className="w-full pl-10 pr-3.5 py-2.5 rounded-xl border border-[#CBD5E1] bg-white text-[#12263F] text-sm focus:border-[#0C7C61] focus:ring-2 focus:ring-[#0C7C61]/20 outline-none transition-all placeholder:text-[#94A3B8] disabled:opacity-60"
            />
          </div>
        </div>

        {/* Password */}
        <div className="space-y-1.5">
          <label
            htmlFor="password"
            className="block text-xs font-semibold uppercase tracking-wider text-[#5E718D]"
          >
            Password
          </label>
          <div className="relative">
            <Lock className="w-4 h-4 text-[#94A3B8] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              required
              disabled={loading}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              className="w-full pl-10 pr-10 py-2.5 rounded-xl border border-[#CBD5E1] bg-white text-[#12263F] text-sm focus:border-[#0C7C61] focus:ring-2 focus:ring-[#0C7C61]/20 outline-none transition-all placeholder:text-[#94A3B8] disabled:opacity-60"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              disabled={loading}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[#94A3B8] hover:text-[#5E718D] p-1 rounded"
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          <p className="text-[11px] text-[#94A3B8]">
            Must contain upper & lower case, number, and special character
          </p>
        </div>

        {/* Submit Button */}
        <button
          type="submit"
          disabled={loading}
          className="w-full py-2.5 px-4 rounded-xl bg-[#0C7C61] hover:bg-[#096851] text-white text-sm font-semibold transition-all disabled:opacity-60 flex items-center justify-center gap-2 shadow-xs touch-target"
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Creating your account...</span>
            </>
          ) : (
            <>
              <span>Create Account & Workspace</span>
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </form>

      {/* Switch to Login */}
      <div className="pt-4 border-t border-[#E3E8EF] text-center text-xs text-[#5E718D]">
        Already have an account?{" "}
        <Link
          href="/login"
          className="font-semibold text-[#0C7C61] hover:text-[#096851] underline underline-offset-2"
        >
          Sign in
        </Link>
      </div>
    </div>
  );
}
