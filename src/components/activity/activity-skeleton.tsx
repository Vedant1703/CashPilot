import React from "react";

export function ActivitySkeleton() {
  return (
    <div
      className="space-y-6 animate-pulse"
      aria-busy="true"
      aria-label="Loading activity history"
    >
      {/* Header skeleton */}
      <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-4 pb-2 border-b border-[#E3E8EF]">
        <div className="space-y-2">
          <div className="h-7 bg-[#E3E8EF] rounded-lg w-36" />
          <div className="h-4 bg-[#EEF2F6] rounded w-72" />
        </div>
        <div className="h-9 bg-[#E3E8EF] rounded-xl w-28" />
      </div>

      {/* 2-column body skeleton */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left timeline (8 cols) */}
        <div className="lg:col-span-8 rounded-2xl border border-[#E3E8EF] bg-white p-5 sm:p-6 space-y-4">
          <div className="h-9 bg-[#F6F5F1] rounded-xl w-full" />
          <div className="space-y-3 pt-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-16 bg-[#F6F5F1] rounded-xl" />
            ))}
          </div>
        </div>

        {/* Right sidebar (4 cols) */}
        <div className="lg:col-span-4 space-y-6">
          <div className="h-80 bg-white rounded-2xl border border-[#E3E8EF] p-5 space-y-4">
            <div className="h-5 bg-[#EEF2F6] rounded w-48" />
            <div className="h-9 bg-[#F6F5F1] rounded-xl w-full" />
            <div className="space-y-3 pt-4">
              <div className="h-8 bg-[#F6F5F1] rounded" />
              <div className="h-8 bg-[#F6F5F1] rounded" />
              <div className="h-8 bg-[#F6F5F1] rounded" />
            </div>
          </div>
          <div className="h-36 bg-white rounded-2xl border border-[#E3E8EF] p-5" />
        </div>
      </div>
    </div>
  );
}
