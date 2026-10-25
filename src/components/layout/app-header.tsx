"use client";

import React, { Suspense, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { CashPilotLogo } from "@/components/brand/cashpilot-logo";
import { RefreshCw, Plus, Menu, X, ShieldAlert, LogOut } from "lucide-react";

interface AppHeaderProps {
  lastSyncAt?: string | null;
  hasStaleInvoices?: boolean;
  workspaceName?: string;
  isDemo?: boolean;
  user?: {
    name: string;
    email: string;
  } | null;
}

function HeaderNavLinks() {
  const pathname = usePathname();

  const navLinks = [
    { href: "/", label: "Dashboard", active: pathname === "/" },
    {
      href: "/collections",
      label: "Collections",
      active: pathname.startsWith("/collections"),
    },
    {
      href: "/invoices",
      label: "Invoices",
      active: pathname.startsWith("/invoices"),
    },
    {
      href: "/navi-ai",
      label: "Ask Navi",
      active: pathname.startsWith("/navi-ai"),
    },
  ];

  return (
    <nav className="hidden md:flex items-center gap-1" aria-label="Main Navigation">
      {navLinks.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className={`px-3.5 py-2 rounded-xl text-sm font-medium transition-colors ${
            link.active
              ? "bg-[#E8F5F1] text-[#0C7C61] font-semibold"
              : "text-[#5E718D] hover:text-[#12263F] hover:bg-[#F6F5F1]"
          }`}
          aria-current={link.active ? "page" : undefined}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}

function HeaderNavFallback() {
  return (
    <nav className="hidden md:flex items-center gap-1" aria-label="Main Navigation Fallback">
      <Link href="/" className="px-3.5 py-2 rounded-xl text-sm font-medium text-[#5E718D]">
        Dashboard
      </Link>
      <Link href="/collections" className="px-3.5 py-2 rounded-xl text-sm font-medium text-[#5E718D]">
        Collections
      </Link>
      <Link href="/invoices" className="px-3.5 py-2 rounded-xl text-sm font-medium text-[#5E718D]">
        Invoices
      </Link>
      <Link href="/navi-ai" className="px-3.5 py-2 rounded-xl text-sm font-medium text-[#5E718D]">
        Ask Navi
      </Link>
    </nav>
  );
}

export function AppHeader({
  lastSyncAt,
  hasStaleInvoices = false,
  workspaceName = "My Freelance Studio",
  isDemo = true,
  user,
}: AppHeaderProps) {
  const router = useRouter();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    window.location.reload();
  };

  const handleLogout = async () => {
    if (isLoggingOut) return;
    setIsLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.push("/login");
      router.refresh();
    }
  };

  return (
    <header className="sticky top-0 z-40 w-full border-b border-[#E3E8EF] bg-white/95 backdrop-blur-md">
      {/* Top Banner: Workspace & Sandbox Environment Notice */}
      <div className="w-full bg-[#12263F] text-white px-4 py-1.5 text-xs">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-[#34C79F] animate-pulse" />
            <span className="font-medium">{workspaceName}</span>
            {isDemo && (
              <>
                <span className="text-white/40">·</span>
                <span className="text-[#34C79F] font-mono font-medium">PayPal Sandbox</span>
                <span className="text-white/40">·</span>
                <span className="text-white/70">No real money moves</span>
              </>
            )}
          </div>

          <div className="flex items-center gap-3">
            {hasStaleInvoices ? (
              <span className="inline-flex items-center gap-1 text-[#F2C65A] font-medium">
                <ShieldAlert className="w-3.5 h-3.5" />
                <span>Sync Stale · Verification Recommended</span>
              </span>
            ) : lastSyncAt ? (
              <span className="text-white/70 text-[11px] font-mono">
                Synced {new Date(lastSyncAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            ) : (
              <span className="text-white/60 text-[11px]">Sandbox active</span>
            )}
          </div>
        </div>
      </div>

      {/* Main Header Bar */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
        {/* Brand Logo */}
        <Link href="/" className="flex items-center focus-visible:ring-2 focus-visible:ring-[#0C7C61] rounded-lg">
          <CashPilotLogo size={36} showText={true} />
        </Link>

        {/* Desktop Navigation wrapped in Suspense */}
        <Suspense fallback={<HeaderNavFallback />}>
          <HeaderNavLinks />
        </Suspense>

        {/* Action CTAs */}
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="hidden sm:inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[#E3E8EF] text-[#12263F] hover:bg-[#F6F5F1] text-xs font-medium transition-colors touch-target disabled:opacity-60"
            aria-label="Refresh status from database"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? "animate-spin text-[#0C7C61]" : "text-[#5E718D]"}`} />
            <span>Refresh</span>
          </button>

          <Link
            href="/invoices/new"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#0C7C61] hover:bg-[#096851] text-white text-xs font-semibold shadow-xs transition-colors touch-target focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[#0C7C61]"
          >
            <Plus className="w-4 h-4 stroke-[2.5]" />
            <span>New invoice</span>
          </Link>

          {/* User profile & logout (Desktop) */}
          {user && (
            <div className="hidden lg:flex items-center gap-2 pl-2 border-l border-[#E3E8EF]">
              <div className="flex flex-col text-right">
                <span className="text-xs font-semibold text-[#12263F] leading-tight truncate max-w-[120px]">
                  {user.name}
                </span>
                <span className="text-[10px] text-[#5E718D] leading-tight truncate max-w-[120px]">
                  {user.email}
                </span>
              </div>
              <button
                type="button"
                onClick={handleLogout}
                disabled={isLoggingOut}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl border border-[#E3E8EF] hover:bg-[#FEF3F2] hover:border-[#FECDCA] hover:text-[#B42318] text-[#5E718D] text-xs font-medium transition-colors"
                title="Sign out of CashPilot"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>{isLoggingOut ? "..." : "Sign out"}</span>
              </button>
            </div>
          )}

          {/* Mobile hamburger button */}
          <button
            type="button"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="md:hidden p-2 rounded-xl text-[#12263F] hover:bg-[#F6F5F1] touch-target"
            aria-label={mobileMenuOpen ? "Close navigation menu" : "Open navigation menu"}
            aria-expanded={mobileMenuOpen}
          >
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Mobile Drawer Menu */}
      {mobileMenuOpen && (
        <div className="md:hidden border-t border-[#E3E8EF] bg-white px-4 py-3 space-y-1">
          <Link
            href="/"
            onClick={() => setMobileMenuOpen(false)}
            className="block px-3 py-2.5 rounded-xl text-sm font-medium text-[#12263F] hover:bg-[#F6F5F1]"
          >
            Dashboard
          </Link>
          <Link
            href="/collections"
            onClick={() => setMobileMenuOpen(false)}
            className="block px-3 py-2.5 rounded-xl text-sm font-medium text-[#12263F] hover:bg-[#F6F5F1]"
          >
            Collections
          </Link>
          <Link
            href="/invoices"
            onClick={() => setMobileMenuOpen(false)}
            className="block px-3 py-2.5 rounded-xl text-sm font-medium text-[#12263F] hover:bg-[#F6F5F1]"
          >
            Invoices
          </Link>
          <Link
            href="/navi-ai"
            onClick={() => setMobileMenuOpen(false)}
            className="block px-3 py-2.5 rounded-xl text-sm font-medium text-[#12263F] hover:bg-[#F6F5F1]"
          >
            Ask Navi
          </Link>

          {user && (
            <div className="px-3 py-2 bg-[#F6F5F1] rounded-xl my-2">
              <div className="text-xs font-semibold text-[#12263F]">{user.name}</div>
              <div className="text-[11px] text-[#5E718D] truncate">{user.email}</div>
            </div>
          )}

          <div className="pt-2 border-t border-[#E3E8EF] space-y-2">
            <button
              type="button"
              onClick={handleRefresh}
              className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border border-[#E3E8EF] text-[#12263F] text-xs font-medium"
            >
              <RefreshCw className="w-3.5 h-3.5 text-[#5E718D]" />
              <span>Refresh Status</span>
            </button>

            {user && (
              <button
                type="button"
                onClick={handleLogout}
                disabled={isLoggingOut}
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border border-[#FECDCA] text-[#B42318] bg-[#FEF3F2] text-xs font-semibold"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>{isLoggingOut ? "Signing out..." : "Sign Out"}</span>
              </button>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
