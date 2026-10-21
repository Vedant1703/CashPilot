import React from "react";
import Link from "next/link";
import { CheckCircle2, Clock, AlertTriangle, ShieldCheck } from "lucide-react";
import type { ActivityFeedItem } from "@/lib/services/dashboard.service";

interface RecentActivityProps {
  activities: ActivityFeedItem[];
}

export function RecentActivity({ activities }: RecentActivityProps) {
  const getEventIcon = (eventType: string) => {
    switch (eventType) {
      case "OPERATION_SUCCEEDED":
      case "STATUS_CONFIRMED":
        return <CheckCircle2 className="w-4 h-4 text-[#0C7C61]" />;
      case "APPROVAL_CONFIRMED":
      case "APPROVAL_CREATED":
        return <ShieldCheck className="w-4 h-4 text-[#B4440B]" />;
      case "OPERATION_FAILED":
        return <AlertTriangle className="w-4 h-4 text-[#B42318]" />;
      default:
        return <Clock className="w-4 h-4 text-[#5E718D]" />;
    }
  };

  return (
    <div id="activity" className="rounded-2xl bg-white border border-[#E3E8EF] p-5 sm:p-6 shadow-xs">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-semibold text-sm text-[#12263F]">
            Recent Audit & Operations Log
          </h3>
          <p className="text-xs text-[#5E718D] mt-0.5">
            Append-only record of approvals, provider calls, and status reconciliations
          </p>
        </div>
        <span className="text-[11px] font-mono text-[#5E718D] px-2 py-0.5 rounded-full bg-[#F6F5F1] border border-[#E3E8EF]">
          Append-Only
        </span>
      </div>

      {activities.length === 0 ? (
        <div className="text-center py-8 text-xs text-[#5E718D]">
          No audit activity recorded yet.
        </div>
      ) : (
        <div className="divide-y divide-[#EEF2F6]">
          {activities.map((act) => {
            const date = new Date(act.createdAt);
            const timeFormatted = date.toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            });
            const dateFormatted = date.toLocaleDateString([], {
              month: "short",
              day: "numeric",
            });

            return (
              <div key={act.id} className="py-3.5 flex items-start gap-3">
                <div className="p-1.5 rounded-lg bg-[#F6F5F1] border border-[#E3E8EF] shrink-0 mt-0.5">
                  {getEventIcon(act.eventType)}
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-xs text-[#12263F] font-medium leading-relaxed">
                    {act.description}
                  </p>

                  <div className="flex flex-wrap items-center gap-2 mt-1 text-[11px] text-[#5E718D]">
                    <span className="capitalize font-mono px-1.5 py-0.2 rounded bg-[#F4F6F8]">
                      {act.actorType.toLowerCase()}
                    </span>
                    <span>·</span>
                    <span>
                      {dateFormatted} at {timeFormatted}
                    </span>
                    {act.invoiceId && (
                      <>
                        <span>·</span>
                        <Link
                          href={`/invoices/${act.invoiceId}`}
                          className="text-[#0C7C61] hover:underline font-mono"
                        >
                          Invoice Details
                        </Link>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
