import React from "react";
import { CashPilotStatus } from "@prisma/client";

interface StatusBadgeProps {
  status: CashPilotStatus | string;
  size?: "sm" | "md";
  className?: string;
}

export function StatusBadge({
  status,
  size = "md",
  className = "",
}: StatusBadgeProps) {
  const norm = status.toUpperCase();

  let label = norm;
  let symbol = "●";
  let colorClasses = "bg-[#F4F6F8] text-[#5E718D] border-[#E3E8EF]";

  switch (norm) {
    case CashPilotStatus.PAID:
      label = "Paid";
      symbol = "✓";
      colorClasses = "bg-[#E8F5F1] text-[#0C7C61] border-[#A3D9CC]";
      break;
    case CashPilotStatus.AWAITING_PAYMENT:
      label = "Awaiting Payment";
      symbol = "●";
      colorClasses = "bg-[#E8F5F1] text-[#0C7C61] border-[#A3D9CC]";
      break;
    case CashPilotStatus.DUE_SOON:
      label = "Due Soon (0–3d)";
      symbol = "◷";
      colorClasses = "bg-[#FEF9E7] text-[#7A5600] border-[#F3E0A2]";
      break;
    case CashPilotStatus.OVERDUE:
      label = "Overdue";
      symbol = "●";
      colorClasses = "bg-[#FEF3F2] text-[#B42318] border-[#FECDCA]";
      break;
    case CashPilotStatus.DRAFT:
      label = "Draft";
      symbol = "○";
      colorClasses = "bg-[#F4F6F8] text-[#5E718D] border-[#E3E8EF]";
      break;
    case CashPilotStatus.CANCELLED:
      label = "Cancelled";
      symbol = "✕";
      colorClasses = "bg-[#F4F6F8] text-[#8A9BA8] border-[#E3E8EF] line-through";
      break;
    case CashPilotStatus.NEEDS_REVIEW:
      label = "Needs Review";
      symbol = "▲";
      colorClasses = "bg-[#FDF2EB] text-[#B4440B] border-[#F7C4A5]";
      break;
    default:
      label = status;
      symbol = "●";
      break;
  }

  const paddingClasses = size === "sm" ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-xs";

  return (
    <span
      className={`inline-flex items-center gap-1.5 font-medium rounded-full border ${paddingClasses} ${colorClasses} ${className}`}
      role="status"
    >
      <span className="font-mono text-[11px] leading-none select-none" aria-hidden="true">
        {symbol}
      </span>
      <span>{label}</span>
    </span>
  );
}
