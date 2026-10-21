import React from "react";

interface CashPilotLogoProps {
  size?: number;
  showText?: boolean;
  showTagline?: boolean;
  className?: string;
}

export function CashPilotLogo({
  size = 32,
  showText = true,
  showTagline = false,
  className = "",
}: CashPilotLogoProps) {
  return (
    <div className={`flex items-center gap-3 ${className}`}>
      {/* Flat stroke brand mark: Document outline with rising bars, growth arrow, and coin mark */}
      <svg
        width={size}
        height={size}
        viewBox="0 0 44 44"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="shrink-0"
        aria-hidden="true"
      >
        {/* Document base */}
        <rect
          x="6"
          y="6"
          width="32"
          height="32"
          rx="8"
          fill="#0C7C61"
          fillOpacity="0.08"
          stroke="#0C7C61"
          strokeWidth="2.5"
        />
        {/* Rising financial bars */}
        <line x1="14" y1="29" x2="14" y2="23" stroke="#0C7C61" strokeWidth="2.5" strokeLinecap="round" />
        <line x1="20" y1="29" x2="20" y2="18" stroke="#0C7C61" strokeWidth="2.5" strokeLinecap="round" />
        <line x1="26" y1="29" x2="26" y2="14" stroke="#0C7C61" strokeWidth="2.5" strokeLinecap="round" />
        {/* Growth navigation arrow */}
        <path
          d="M22 13L29 13M29 13L29 20M29 13L16 26"
          stroke="#0C7C61"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Verified coin mark */}
        <circle cx="31" cy="31" r="4.5" fill="#0C7C61" />
        <path d="M29.5 31L30.5 32L32.5 30" stroke="#FFFFFF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>

      {showText && (
        <div className="flex flex-col">
          <div className="flex items-center gap-1.5 leading-none">
            <span className="font-headline font-semibold text-xl tracking-tight text-[#12263F]">
              CashPilot
            </span>
            <span className="text-[10px] font-mono font-semibold tracking-wider uppercase px-1.5 py-0.5 rounded bg-[#F0EEFF] text-[#5B3FD0] border border-[#CDC4FF]">
              AI
            </span>
          </div>
          {showTagline && (
            <span className="text-xs text-[#5E718D] mt-0.5">
              Smarter receivables. Stronger business.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
