import React from "react";

export function CollectionsSkeleton() {
  return (
    <div className="space-y-6 animate-pulse" aria-busy="true" aria-label="Loading collections board">
      <div className="flex justify-between items-center pb-4 border-b border-[#E3E8EF]">
        <div className="space-y-2">
          <div className="h-6 bg-[#EEF2F6] rounded-md w-48" />
          <div className="h-4 bg-[#EEF2F6] rounded-md w-64" />
        </div>
        <div className="h-9 bg-[#EEF2F6] rounded-xl w-32" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        {[1, 2, 3, 4, 5].map((col) => (
          <div key={col} className="rounded-2xl bg-[#F6F5F1] border border-[#E3E8EF] p-3 min-h-[380px] space-y-3">
            <div className="flex justify-between">
              <div className="h-4 bg-[#E3E8EF] rounded-md w-1/2" />
              <div className="h-4 bg-[#E3E8EF] rounded-full w-6" />
            </div>
            <div className="h-28 bg-white rounded-xl border border-[#E3E8EF]" />
            <div className="h-28 bg-white rounded-xl border border-[#E3E8EF]" />
          </div>
        ))}
      </div>
    </div>
  );
}
