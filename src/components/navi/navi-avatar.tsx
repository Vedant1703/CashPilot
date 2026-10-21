import React from "react";

export type NaviState = "idle" | "thinking" | "helping" | "done";

interface NaviAvatarProps {
  state?: NaviState;
  size?: number;
  className?: string;
  showStatusIndicator?: boolean;
}

export function NaviAvatar({
  state = "idle",
  size = 40,
  className = "",
  showStatusIndicator = false,
}: NaviAvatarProps) {
  // Eye / Visor expression based on Navi state
  const renderVisorEyes = () => {
    switch (state) {
      case "thinking":
        return (
          <g>
            {/* Thinking pulsing glow / dots */}
            <circle cx="16" cy="18" r="2" fill="#FFFFFF" opacity="0.9" />
            <circle cx="24" cy="18" r="2.5" fill="#34C79F" />
            <circle cx="32" cy="18" r="2" fill="#FFFFFF" opacity="0.9" />
          </g>
        );
      case "helping":
        return (
          <g>
            {/* Helping engaged curved eyes */}
            <path
              d="M15 19C15 16.5 18 16.5 18 19"
              stroke="#FFFFFF"
              strokeWidth="2"
              strokeLinecap="round"
            />
            <path
              d="M30 19C30 16.5 33 16.5 33 19"
              stroke="#FFFFFF"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </g>
        );
      case "done":
        return (
          <g>
            {/* Done verified happy arcs */}
            <path
              d="M14 18C15 15.5 19 15.5 20 18"
              stroke="#34C79F"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
            <path
              d="M28 18C29 15.5 33 15.5 34 18"
              stroke="#34C79F"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
          </g>
        );
      case "idle":
      default:
        return (
          <g>
            {/* Friendly focused eyes */}
            <circle cx="17" cy="18" r="2.5" fill="#FFFFFF" />
            <circle cx="31" cy="18" r="2.5" fill="#FFFFFF" />
          </g>
        );
    }
  };

  return (
    <div
      className={`relative inline-flex items-center justify-center shrink-0 ${className}`}
      style={{ width: size, height: size }}
      aria-label={`Navi Copilot (${state})`}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 48 48"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="w-full h-full drop-shadow-xs"
      >
        {/* Teal Headset band */}
        <path
          d="M8 22C8 13.1634 15.1634 6 24 6C32.8366 6 40 13.1634 40 22"
          stroke="#0C7C61"
          strokeWidth="3.5"
          strokeLinecap="round"
        />

        {/* Headset Earcups (Teal with accent) */}
        <rect x="5" y="19" width="5" height="12" rx="2.5" fill="#0C7C61" />
        <rect x="38" y="19" width="5" height="12" rx="2.5" fill="#0C7C61" />

        {/* Headset Mic boom */}
        <path
          d="M7 26C7 33 14 36 18 36"
          stroke="#0C7C61"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        <circle cx="18" cy="36" r="2" fill="#34C79F" />

        {/* Robot Head Body */}
        <rect
          x="10"
          y="10"
          width="28"
          height="24"
          rx="12"
          fill="#12263F"
          stroke="#E3E8EF"
          strokeWidth="1.5"
        />

        {/* Dark Visor Window */}
        <rect
          x="12"
          y="13"
          width="24"
          height="14"
          rx="7"
          fill="#0B1827"
        />

        {/* Dynamic Eyes inside Visor */}
        {renderVisorEyes()}

        {/* Chest Plate / Navigation Arrow */}
        <rect
          x="15"
          y="35"
          width="18"
          height="9"
          rx="4.5"
          fill="#FFFFFF"
          stroke="#0C7C61"
          strokeWidth="1.5"
        />
        {/* Upward Navigation Arrow on chest */}
        <path
          d="M24 37L28 41H20L24 37Z"
          fill={state === "done" ? "#0C7C61" : "#5B3FD0"}
        />
      </svg>

      {/* Optional tiny state chip */}
      {showStatusIndicator && (
        <span
          className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white ${
            state === "done"
              ? "bg-[#0C7C61]"
              : state === "thinking"
              ? "bg-[#5B3FD0] animate-pulse"
              : state === "helping"
              ? "bg-[#B4440B]"
              : "bg-[#0C7C61]"
          }`}
          aria-hidden="true"
        />
      )}
    </div>
  );
}
