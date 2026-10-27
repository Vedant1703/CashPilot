"use client";

import React, { useState, useEffect } from "react";
import { X, UserPlus, Edit3, AlertCircle, Loader2 } from "lucide-react";

export interface ClientItem {
  id: string;
  name: string;
  email: string;
  company: string | null;
  phone: string | null;
  notes: string | null;
  isDemo: boolean;
  createdAt: string | Date;
  updatedAt: string | Date;
  _count?: {
    invoices: number;
  };
}

export interface ClientFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (client: ClientItem) => void;
  initialClient?: ClientItem | null;
}

export function ClientFormModal(props: ClientFormModalProps) {
  if (!props.isOpen) return null;
  return (
    <ClientFormModalContent
      key={props.initialClient?.id ?? "create"}
      {...props}
    />
  );
}

function ClientFormModalContent({
  onClose,
  onSuccess,
  initialClient,
}: ClientFormModalProps) {
  const isEdit = Boolean(initialClient);

  const [name, setName] = useState(initialClient?.name || "");
  const [email, setEmail] = useState(initialClient?.email || "");
  const [company, setCompany] = useState(initialClient?.company || "");
  const [phone, setPhone] = useState(initialClient?.phone || "");
  const [notes, setNotes] = useState(initialClient?.notes || "");

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Handle Escape key to close modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isSubmitting) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isSubmitting, onClose]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    const trimmedCompany = company.trim();
    const trimmedPhone = phone.trim();
    const trimmedNotes = notes.trim();

    // Client-side validation checks
    if (!trimmedName) {
      setError("Client name is required.");
      return;
    }
    if (trimmedName.length > 100) {
      setError("Client name must be 100 characters or fewer.");
      return;
    }

    if (!trimmedEmail) {
      setError("Email address is required.");
      return;
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmedEmail)) {
      setError("Please enter a valid email address.");
      return;
    }
    if (trimmedEmail.length > 255) {
      setError("Email address must be 255 characters or fewer.");
      return;
    }

    if (trimmedCompany.length > 100) {
      setError("Company name must be 100 characters or fewer.");
      return;
    }
    if (trimmedPhone.length > 50) {
      setError("Phone number must be 50 characters or fewer.");
      return;
    }
    if (trimmedNotes.length > 1000) {
      setError("Notes must be 1000 characters or fewer.");
      return;
    }

    setIsSubmitting(true);

    try {
      const url = isEdit && initialClient ? `/api/clients/${initialClient.id}` : "/api/clients";
      const method = isEdit ? "PATCH" : "POST";

      const payload = isEdit
        ? {
            name: trimmedName,
            email: trimmedEmail,
            company: trimmedCompany || null,
            phone: trimmedPhone || null,
            notes: trimmedNotes || null,
          }
        : {
            name: trimmedName,
            email: trimmedEmail,
            company: trimmedCompany || undefined,
            phone: trimmedPhone || undefined,
            notes: trimmedNotes || undefined,
          };

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const json = await res.json();

      if (!res.ok || !json.success) {
        // Preserve form input and show readable server error message
        setError(json.error || "Failed to save client details.");
        return;
      }

      onSuccess(json.data);
      onClose();
    } catch {
      // Preserve form input on network failure
      setError("Network error while saving client. Please check your connection and try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="client-form-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs animate-in fade-in duration-150 overflow-y-auto"
    >
      <div className="relative w-full max-w-lg my-8 rounded-2xl bg-white border border-[#E3E8EF] shadow-2xl p-6 sm:p-7 space-y-5 text-[#12263F] animate-in zoom-in-95 duration-150">
        {/* Close Button */}
        <button
          type="button"
          onClick={onClose}
          disabled={isSubmitting}
          aria-label="Close client modal"
          className="absolute top-5 right-5 p-2 rounded-xl text-[#5E718D] hover:text-[#12263F] hover:bg-[#F6F5F1] transition-colors disabled:opacity-50 min-h-[44px] min-w-[44px] flex items-center justify-center focus-visible:ring-2 focus-visible:ring-[#0C7C61] focus-visible:outline-hidden"
        >
          <X className="w-5 h-5" aria-hidden="true" />
        </button>

        {/* Modal Header */}
        <div className="flex items-center gap-3 pr-8">
          <div className="p-2.5 rounded-xl bg-[#E8F5F1] text-[#0C7C61] shrink-0 border border-[#A3E5D4]">
            {isEdit ? (
              <Edit3 className="w-5 h-5 stroke-[2.25]" aria-hidden="true" />
            ) : (
              <UserPlus className="w-5 h-5 stroke-[2.25]" aria-hidden="true" />
            )}
          </div>
          <div>
            <h2
              id="client-form-modal-title"
              className="font-headline font-bold text-xl text-[#12263F]"
            >
              {isEdit ? "Edit Client Profile" : "Add New Client"}
            </h2>
            <p className="text-xs text-[#5E718D] mt-0.5">
              {isEdit
                ? "Update client contact information for your workspace."
                : "Create a recipient record to use when drafting invoices."}
            </p>
          </div>
        </div>

        {/* Error Alert */}
        {error && (
          <div
            role="alert"
            className="p-3.5 rounded-xl bg-[#FEF3F2] border border-[#FECDCA] text-[#B42318] text-xs flex items-start gap-2.5 animate-in fade-in duration-100"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span className="leading-relaxed">{error}</span>
          </div>
        )}

        {/* Client Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="client-name" className="block text-xs font-semibold text-[#12263F]">
              Client Name <span className="text-[#B42318]">*</span>
            </label>
            <input
              id="client-name"
              type="text"
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Acme Corporation or Jane Smith"
              disabled={isSubmitting}
              className="w-full px-3.5 py-2.5 rounded-xl border border-[#E3E8EF] text-xs sm:text-sm bg-[#F6F5F1]/30 placeholder:text-[#8A9BA8] focus:border-[#0C7C61] focus:ring-1 focus:ring-[#0C7C61] focus:outline-hidden disabled:opacity-60 transition-colors"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="client-email" className="block text-xs font-semibold text-[#12263F]">
              Billing Email <span className="text-[#B42318]">*</span>
            </label>
            <input
              id="client-email"
              type="email"
              required
              maxLength={255}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="e.g., billing@acme.com"
              disabled={isSubmitting}
              className="w-full px-3.5 py-2.5 rounded-xl border border-[#E3E8EF] text-xs sm:text-sm bg-[#F6F5F1]/30 placeholder:text-[#8A9BA8] focus:border-[#0C7C61] focus:ring-1 focus:ring-[#0C7C61] focus:outline-hidden disabled:opacity-60 transition-colors"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <div className="space-y-1.5">
              <label htmlFor="client-company" className="block text-xs font-semibold text-[#12263F]">
                Company <span className="text-[#5E718D] font-normal text-[11px]">(Optional)</span>
              </label>
              <input
                id="client-company"
                type="text"
                maxLength={100}
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="e.g., Acme Industries"
                disabled={isSubmitting}
                className="w-full px-3.5 py-2.5 rounded-xl border border-[#E3E8EF] text-xs sm:text-sm bg-[#F6F5F1]/30 placeholder:text-[#8A9BA8] focus:border-[#0C7C61] focus:ring-1 focus:ring-[#0C7C61] focus:outline-hidden disabled:opacity-60 transition-colors"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="client-phone" className="block text-xs font-semibold text-[#12263F]">
                Phone <span className="text-[#5E718D] font-normal text-[11px]">(Optional)</span>
              </label>
              <input
                id="client-phone"
                type="tel"
                maxLength={50}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="e.g., +1 (555) 0199"
                disabled={isSubmitting}
                className="w-full px-3.5 py-2.5 rounded-xl border border-[#E3E8EF] text-xs sm:text-sm bg-[#F6F5F1]/30 placeholder:text-[#8A9BA8] focus:border-[#0C7C61] focus:ring-1 focus:ring-[#0C7C61] focus:outline-hidden disabled:opacity-60 transition-colors"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="client-notes" className="block text-xs font-semibold text-[#12263F]">
              Internal Notes <span className="text-[#5E718D] font-normal text-[11px]">(Optional)</span>
            </label>
            <textarea
              id="client-notes"
              rows={3}
              maxLength={1000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Private workspace notes (payment terms, PO contact, etc.)"
              disabled={isSubmitting}
              className="w-full px-3.5 py-2.5 rounded-xl border border-[#E3E8EF] text-xs sm:text-sm bg-[#F6F5F1]/30 placeholder:text-[#8A9BA8] focus:border-[#0C7C61] focus:ring-1 focus:ring-[#0C7C61] focus:outline-hidden disabled:opacity-60 transition-colors leading-relaxed"
            />
          </div>

          {/* Modal Actions */}
          <div className="pt-3 border-t border-[#EEF2F6] flex flex-col-reverse sm:flex-row items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="w-full sm:w-auto px-4 py-2.5 rounded-xl border border-[#E3E8EF] hover:bg-[#F6F5F1] text-xs font-semibold text-[#5E718D] hover:text-[#12263F] transition-colors disabled:opacity-50 min-h-[44px]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-[#0C7C61] hover:bg-[#09634E] text-white text-xs font-semibold shadow-xs transition-colors disabled:opacity-50 min-h-[44px] focus-visible:ring-2 focus-visible:ring-[#0C7C61]"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                  <span>Saving...</span>
                </>
              ) : (
                <span>{isEdit ? "Save Changes" : "Create Client"}</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
