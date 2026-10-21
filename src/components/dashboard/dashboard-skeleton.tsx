import React from "react";
import { NaviAvatar } from "@/components/navi/navi-avatar";

export function DashboardSkeleton() {
  return (
    <div className="space-y-6 sm:space-y-8 animate-pulse" aria-busy="true" aria-label="Loading dashboard">
      {/* Navi Greeting Callout Skeleton */}
      <div className="rounded-2xl bg-white border border-[#E3E8EF] p-6 shadow-xs flex items-center gap-4">
        <NaviAvatar state="thinking" size={48} />
        <div className="space-y-2 flex-1">
          <div className="h-4 bg-[#EEF2F6] rounded-md w-1/4" />
          <div className="h-6 bg-[#EEF2F6] rounded-md w-2/3" />
          <p className="text-xs text-[#5E718D] italic">
            Opening your board. Loading invoices. Totals appear once every status is read.
          </p>
        </div>
      </div>

      {/* 4 Metric Cards Skeletons */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="rounded-2xl bg-white border border-[#E3E8EF] p-5 shadow-xs space-y-3">
            <div className="flex justify-between">
              <div className="h-3 bg-[#EEF2F6] rounded-md w-1/3" />
              <div className="h-4 bg-[#EEF2F6] rounded-full w-12" />
            </div>
            <div className="h-8 bg-[#EEF2F6] rounded-md w-2/3" />
            <div className="h-3 bg-[#EEF2F6] rounded-md w-1/2 pt-2 border-t border-[#EEF2F6]" />
          </div>
        ))}
      </div>

      {/* Two-column mid section skeleton */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 rounded-2xl bg-white border border-[#E3E8EF] p-6 h-64 shadow-xs">
          <div className="h-4 bg-[#EEF2F6] rounded-md w-1/3 mb-4" />
          <div className="space-y-3">
            <div className="h-16 bg-[#F6F5F1] rounded-xl" />
            <div className="h-16 bg-[#F6F5F1] rounded-xl" />
          </div>
        </div>
        <div className="lg:col-span-5 rounded-2xl bg-white border border-[#E3E8EF] p-6 h-64 shadow-xs">
          <div className="h-4 bg-[#EEF2F6] rounded-md w-1/3 mb-4" />
          <div className="h-3 bg-[#EEF2F6] rounded-full mb-6" />
          <div className="space-y-2">
            <div className="h-10 bg-[#F6F5F1] rounded-xl" />
            <div className="h-10 bg-[#F6F5F1] rounded-xl" />
          </div>
        </div>
      </div>
    </div>
  );
}
