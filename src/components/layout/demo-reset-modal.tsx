"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  RotateCcw,
  AlertTriangle,
  X,
  CheckCircle2,
  Loader2,
  Info,
} from "lucide-react";

const CANONICAL_INVOICE_IDS = new Set([
  "demo-invoice-1",
  "demo-invoice-2",
  "demo-invoice-3",
  "demo-invoice-4",
]);

export function isViewingNonCanonicalInvoice(pathname: string | null): boolean {
  if (!pathname) return false;
  const match = pathname.match(/^\/invoices\/([^/]+)$/);
  if (!match) return false;
  const invoiceId = match[1];
  if (invoiceId === "new") return false;
  return !CANONICAL_INVOICE_IDS.has(invoiceId);
}

export interface DemoResetModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function DemoResetModal({ isOpen, onClose }: DemoResetModalProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [isResetting, setIsResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const handleClose = useCallback(() => {
    if (isResetting) return;
    setError(null);
    setSuccessMessage(null);
    onClose();
  }, [isResetting, onClose]);

  // Handle ESC key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isResetting) {
        handleClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, isResetting, handleClose]);

  if (!isOpen) return null;

  const handleConfirmReset = async () => {
    if (isResetting) return;
    setIsResetting(true);
    setError(null);

    try {
      const res = await fetch("/api/demo/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      const json = await res.json();

      if (!res.ok || !json.success) {
        setError(json.error || "Failed to reset demo workspace. Please try again.");
        setIsResetting(false);
        return;
      }

      setSuccessMessage(
        json.data?.message || "Demo workspace successfully restored to baseline."
      );

      // Give visual feedback briefly, then refresh or navigate to dashboard
      setTimeout(() => {
        setIsResetting(false);
        onClose();
        if (isViewingNonCanonicalInvoice(pathname)) {
          router.push("/dashboard");
        } else {
          router.refresh();
        }
      }, 1200);
    } catch {
      setError("Network error while resetting demo data. Please try again.");
      setIsResetting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="demo-reset-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-150"
    >
      <div className="relative w-full max-w-lg bg-white rounded-2xl shadow-2xl border border-[#E3E8EF] overflow-hidden">
        {/* Header */}
        <div className="p-5 border-b border-[#E3E8EF] flex items-center justify-between bg-[#F8F9FA]">
          <div className="flex items-center gap-2.5">
            <span className="p-2 rounded-xl bg-[#FEF3F2] text-[#B42318] border border-[#FECDCA]">
              <RotateCcw className="w-5 h-5" />
            </span>
            <div>
              <h3
                id="demo-reset-modal-title"
                className="font-bold text-base text-[#12263F]"
              >
                Reset Demo Workspace
              </h3>
              <p className="text-xs text-[#5E718D]">
                Restore My Freelance Studio to original seeded state
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleClose}
            disabled={isResetting}
            aria-label="Close dialog"
            className="p-1.5 rounded-lg text-[#5E718D] hover:text-[#12263F] hover:bg-white disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-5 space-y-4 text-xs text-[#12263F]">
          {error && (
            <div
              role="alert"
              className="p-3.5 rounded-xl bg-[#FEF3F2] border border-[#FECDCA] text-[#B42318] flex items-start gap-2"
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {successMessage && (
            <div
              role="status"
              className="p-3.5 rounded-xl bg-[#F0FAF7] border border-[#A3D9CC] text-[#0C7C61] flex items-start gap-2"
            >
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              <span className="font-medium">{successMessage}</span>
            </div>
          )}

          <p className="leading-relaxed">
            This will restore the Demo Workspace to its canonical baseline with the
            original <strong>4 demonstration invoices</strong> and <strong>3 demo clients</strong>.
          </p>

          <div className="p-3.5 rounded-xl bg-[#FEF9E7] border border-[#F3E0A2] space-y-2 text-[#7A5600]">
            <div className="flex items-center gap-1.5 font-semibold text-xs text-[#7A5600]">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>What will be reset:</span>
            </div>
            <ul className="list-disc pl-5 space-y-1 text-[11px] leading-relaxed">
              <li>Any newly drafted or sent demo invoices will be removed.</li>
              <li>New demo clients and AI-generated drafts will be removed.</li>
              <li>The 4 canonical demo invoices (Draft, Due Soon, Overdue, Paid) will be restored.</li>
            </ul>
          </div>

          {/* PayPal Notice (Requirement 9 & 10) */}
          <div className="p-3.5 rounded-xl bg-[#F6F8FA] border border-[#E3E8EF] flex items-start gap-2 text-[11px] text-[#5E718D] leading-relaxed">
            <Info className="w-4 h-4 shrink-0 mt-0.5 text-[#0F6CBD]" />
            <span>
              <strong>PayPal Sandbox Notice:</strong> Resetting local demo data does
              not cancel or delete previously sent invoices on PayPal Sandbox. CashPilot
              never performs unauthorized external write operations during a local reset.
            </span>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="p-4 bg-[#F8F9FA] border-t border-[#E3E8EF] flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={handleClose}
            disabled={isResetting}
            className="px-4 py-2 min-h-[40px] rounded-xl border border-[#CBD5E1] bg-white hover:bg-[#F6F5F1] text-xs font-semibold text-[#12263F] transition-colors disabled:opacity-50"
          >
            Cancel
          </button>

          <button
            type="button"
            onClick={handleConfirmReset}
            disabled={isResetting || Boolean(successMessage)}
            id="confirm-demo-reset-btn"
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 min-h-[40px] rounded-xl bg-[#B42318] hover:bg-[#912018] text-white text-xs font-semibold shadow-xs active:scale-[0.98] transition-all disabled:opacity-50"
          >
            {isResetting ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Restoring...</span>
              </>
            ) : successMessage ? (
              <>
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Restored!</span>
              </>
            ) : (
              <>
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Confirm Reset Demo Data</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
