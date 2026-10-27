"use client";

import React, { useState, useEffect, useCallback } from "react";
import { X, AlertTriangle, Trash2, ShieldAlert, Loader2 } from "lucide-react";
import type { ClientItem } from "./client-form-modal";

export interface ClientDeleteModalProps {
  client: ClientItem | null;
  isOpen: boolean;
  onClose: () => void;
  onDeleteSuccess: (deletedId: string) => void;
}

export function ClientDeleteModal({
  client,
  isOpen,
  onClose,
  onDeleteSuccess,
}: ClientDeleteModalProps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClose = useCallback(() => {
    if (isDeleting) return;
    setError(null);
    onClose();
  }, [isDeleting, onClose]);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isDeleting) {
        handleClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, isDeleting, handleClose]);

  if (!isOpen || !client) return null;

  const invoiceCount = client._count?.invoices ?? 0;

  const handleDelete = async () => {
    if (isDeleting) return;

    setIsDeleting(true);
    setError(null);

    try {
      const res = await fetch(`/api/clients/${client.id}`, {
        method: "DELETE",
      });

      const json = await res.json();

      if (!res.ok || !json.success) {
        if (res.status === 409 || json.code === "CANNOT_DELETE_CLIENT_WITH_INVOICES") {
          setError(
            "This client cannot be deleted because they have associated invoice records. Client records must be retained for invoice and financial history."
          );
        } else {
          setError(json.error || "Failed to delete client.");
        }
        return;
      }

      onDeleteSuccess(client.id);
      onClose();
    } catch {
      setError("Network error while deleting client. Please check your connection.");
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="client-delete-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs animate-in fade-in duration-150 overflow-y-auto"
    >
      <div className="relative w-full max-w-md my-8 rounded-2xl bg-white border-2 border-[#D92D20] shadow-2xl p-6 sm:p-7 space-y-5 text-[#12263F] animate-in zoom-in-95 duration-150">
        {/* Close Button */}
        <button
          type="button"
          onClick={handleClose}
          disabled={isDeleting}
          aria-label="Close delete modal"
          className="absolute top-5 right-5 p-2 rounded-xl text-[#5E718D] hover:text-[#12263F] hover:bg-[#F6F5F1] transition-colors disabled:opacity-50 min-h-[44px] min-w-[44px] flex items-center justify-center focus-visible:ring-2 focus-visible:ring-[#D92D20] focus-visible:outline-hidden"
        >
          <X className="w-5 h-5" aria-hidden="true" />
        </button>

        {/* Warning Header */}
        <div className="flex items-start gap-3.5 pr-8">
          <div className="p-3 rounded-xl bg-[#FEF3F2] text-[#D92D20] border border-[#FECDCA] shrink-0">
            <AlertTriangle className="w-6 h-6 stroke-[2.25]" aria-hidden="true" />
          </div>

          <div className="space-y-1">
            <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold uppercase tracking-wider text-[#B42318] bg-[#FEF3F2] border border-[#FECDCA]">
              <ShieldAlert className="w-3 h-3" aria-hidden="true" />
              <span>Confirm Deletion</span>
            </div>
            <h2
              id="client-delete-modal-title"
              className="font-headline font-bold text-xl text-[#12263F]"
            >
              Delete Client
            </h2>
          </div>
        </div>

        {/* Error Alert */}
        {error && (
          <div
            role="alert"
            className="p-3.5 rounded-xl bg-[#FEF3F2] border border-[#FECDCA] text-[#B42318] text-xs space-y-1 animate-in fade-in duration-100"
          >
            <div className="font-semibold flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>Cannot Delete Client</span>
            </div>
            <p className="leading-relaxed">{error}</p>
          </div>
        )}

        {/* Client Details Summary */}
        <div className="p-4 rounded-xl bg-[#F6F5F1] border border-[#E3E8EF] space-y-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-[#5E718D]">Client Name:</span>
            <span className="font-semibold text-[#12263F]">{client.name}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[#5E718D]">Email:</span>
            <span className="font-mono text-[#12263F]">{client.email}</span>
          </div>
          {client.company && (
            <div className="flex items-center justify-between">
              <span className="text-[#5E718D]">Company:</span>
              <span className="text-[#12263F]">{client.company}</span>
            </div>
          )}
          <div className="flex items-center justify-between pt-1 border-t border-[#E3E8EF]">
            <span className="text-[#5E718D]">Associated Invoices:</span>
            <span
              className={`font-mono font-semibold px-2 py-0.5 rounded-full text-[11px] ${
                invoiceCount > 0
                  ? "bg-[#FEF3F2] text-[#B42318] border border-[#FECDCA]"
                  : "bg-[#E8F5F1] text-[#0C7C61] border border-[#A3E5D4]"
              }`}
            >
              {`${invoiceCount} ${invoiceCount === 1 ? "invoice" : "invoices"}`}
            </span>
          </div>
        </div>

        {/* Warning text if client has invoices */}
        {invoiceCount > 0 && (
          <p className="text-xs text-[#5E718D] leading-relaxed">
            This client has <strong className="text-[#12263F]">{invoiceCount}</strong> associated{" "}
            {invoiceCount === 1 ? "invoice" : "invoices"}. Clients referenced by financial records
            cannot be deleted.
          </p>
        )}

        {/* Modal Actions */}
        <div className="pt-2 flex flex-col-reverse sm:flex-row items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={handleClose}
            disabled={isDeleting}
            className="w-full sm:w-auto px-4 py-2.5 rounded-xl border border-[#E3E8EF] hover:bg-[#F6F5F1] text-xs font-semibold text-[#5E718D] hover:text-[#12263F] transition-colors disabled:opacity-50 min-h-[44px]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={isDeleting}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-[#D92D20] hover:bg-[#B42318] text-white text-xs font-semibold shadow-xs transition-colors disabled:opacity-50 min-h-[44px] focus-visible:ring-2 focus-visible:ring-[#D92D20]"
          >
            {isDeleting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                <span>Deleting...</span>
              </>
            ) : (
              <>
                <Trash2 className="w-4 h-4" aria-hidden="true" />
                <span>Delete Client</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
