"use client";

import React, { Suspense } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Kanban, FileText, Sparkles } from "lucide-react";

function MobileNavTabs() {
  const pathname = usePathname();

  const tabs = [
    { href: "/", label: "Home", icon: Home, active: pathname === "/" },
    {
      href: "/collections",
      label: "Collections",
      icon: Kanban,
      active: pathname.startsWith("/collections"),
    },
    {
      href: "/invoices",
      label: "Invoices",
      icon: FileText,
      active: pathname.startsWith("/invoices"),
    },
    {
      href: "#activity",
      label: "Activity",
      icon: Sparkles,
      active: false,
    },
  ];

  return (
    <div className="flex items-center justify-around">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`flex flex-col items-center justify-center py-1.5 px-3 rounded-xl touch-target text-[11px] font-medium transition-colors ${
              tab.active
                ? "text-[#0C7C61] font-semibold"
                : "text-[#5E718D] hover:text-[#12263F]"
            }`}
            aria-current={tab.active ? "page" : undefined}
          >
            <Icon className={`w-5 h-5 mb-0.5 ${tab.active ? "stroke-[2.5]" : "stroke-[1.75]"}`} />
            <span>{tab.label}</span>
          </Link>
        );
      })}
    </div>
  );
}

export function MobileNav() {
  return (
    <nav
      className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t border-[#E3E8EF] px-2 py-1"
      aria-label="Mobile Navigation"
    >
      <Suspense fallback={<div className="h-12" />}>
        <MobileNavTabs />
      </Suspense>
    </nav>
  );
}
