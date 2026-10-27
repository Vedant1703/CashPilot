"use client";

import React, { useState, useMemo } from "react";
import { computeInvoiceTotals, formatMoney, parseMoneyToMinorUnits } from "@/lib/money";
import {
  Plus,
  Trash2,
  AlertTriangle,
  ArrowRight,
  ArrowLeft,
  FileCheck,
  Sparkles,
} from "lucide-react";
import { PersistedStudioInvoice } from "./types";
import { ClientFormModal, type ClientItem } from "@/components/clients/client-form-modal";

export interface EditableLineItem {
  id: string;
  description: string;
  quantity: number;
  unitPriceDollars: string;
}

export interface ReviewDraftFormData {
  clientId: string;
  recipientEmail: string;
  title: string;
  invoiceDate: string;
  dueDate: string;
  currency: string;
  taxRatePercent: number; // e.g. 10 for 10%
  lineItems: EditableLineItem[];
  notes: string;
  terms: string;
}

interface ReviewStepProps {
  initialData: Partial<ReviewDraftFormData>;
  knownClients: Array<{ id: string; name: string; email: string; company?: string | null }>;
  missingFields: string[];
  extractionSource?: "ai_model" | "deterministic_rule_based";
  modelName?: string;
  onBack: () => void;
  onDraftSaved: (persistedInvoice: PersistedStudioInvoice, materialPayloadHash: string) => void;
  onClientCreated?: (newClient: { id: string; name: string; email: string; company?: string | null }) => void;
}

export function ReviewStep({
  initialData,
  knownClients,
  missingFields = [],
  extractionSource = "deterministic_rule_based",
  modelName,
  onBack,
  onDraftSaved,
  onClientCreated,
}: ReviewStepProps) {
  // Quick-add client state
  const [isQuickAddOpen, setIsQuickAddOpen] = useState(false);
  const [createdClients, setCreatedClients] = useState<
    Array<{ id: string; name: string; email: string; company?: string | null }>
  >([]);

  // De-duplicated combined client options
  const allClients = useMemo(() => {
    const map = new Map<string, { id: string; name: string; email: string; company?: string | null }>();
    for (const c of knownClients) {
      map.set(c.id, c);
    }
    for (const c of createdClients) {
      map.set(c.id, c);
    }
    return Array.from(map.values());
  }, [knownClients, createdClients]);

  // Form State with pure lazy initializers
  const [clientId, setClientId] = useState<string>(
    () => (initialData.clientId !== undefined ? initialData.clientId : "")
  );
  const [recipientEmail, setRecipientEmail] = useState<string>(
    () => (initialData.recipientEmail !== undefined ? initialData.recipientEmail : "")
  );
  const [title, setTitle] = useState<string>(
    () => initialData.title || "Invoice Draft"
  );
  const [invoiceDate, setInvoiceDate] = useState<string>(
    () => initialData.invoiceDate || new Date().toISOString().substring(0, 10)
  );
  const [dueDate, setDueDate] = useState<string>(
    () => (initialData.dueDate !== undefined ? initialData.dueDate : "")
  );
  const [currency] = useState<string>("USD");
  const [taxRatePercent, setTaxRatePercent] = useState<number>(
    () => initialData.taxRatePercent ?? 0
  );
  const [notes, setNotes] = useState<string>(
    () => initialData.notes ?? ""
  );
  const [terms, setTerms] = useState<string>(
    () => initialData.terms ?? "Payment due upon receipt or within net terms."
  );

  const [lineItems, setLineItems] = useState<EditableLineItem[]>(
    initialData.lineItems && initialData.lineItems.length > 0
      ? initialData.lineItems
      : [
          {
            id: "item-1",
            description: "",
            quantity: 1,
            unitPriceDollars: "",
          },
        ]
  );

  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Update client selection
  const handleClientChange = (newClientId: string) => {
    setClientId(newClientId);
    const client = allClients.find((c) => c.id === newClientId);
    if (client) {
      setRecipientEmail(client.email);
    }
  };

  // Quick-add client callback
  const handleQuickAddSuccess = (newClient: ClientItem) => {
    setCreatedClients((prev) => [...prev, newClient]);
    onClientCreated?.(newClient);
    setClientId(newClient.id);
    setRecipientEmail(newClient.email);
    setIsQuickAddOpen(false);
  };

  // Add line item
  const handleAddLineItem = () => {
    const newItem: EditableLineItem = {
      id: `item-${Date.now()}`,
      description: "",
      quantity: 1,
      unitPriceDollars: "",
    };
    setLineItems([...lineItems, newItem]);
  };

  // Remove line item
  const handleRemoveLineItem = (id: string) => {
    if (lineItems.length <= 1) return;
    setLineItems(lineItems.filter((i) => i.id !== id));
  };

  // Update line item
  const handleUpdateLineItem = (id: string, field: keyof EditableLineItem, value: string | number) => {
    setLineItems(
      lineItems.map((item) => {
        if (item.id === id) {
          return { ...item, [field]: value };
        }
        return item;
      })
    );
  };

  // Deterministic financial calculation using integer minor units
  const financialTotals = useMemo(() => {
    const minorUnitItems = lineItems.map((li) => {
      let unitPriceMinor = 0;
      try {
        unitPriceMinor = parseMoneyToMinorUnits(li.unitPriceDollars || "0") ?? 0;
      } catch {
        unitPriceMinor = 0;
      }
      return {
        quantity: Math.max(li.quantity || 1, 1),
        unitPriceMinorUnits: unitPriceMinor,
      };
    });

    const taxBasisPoints = Math.round(taxRatePercent * 100);
    return computeInvoiceTotals(minorUnitItems, taxBasisPoints);
  }, [lineItems, taxRatePercent]);

  // Handle Save Draft & Proceed
  const handleSaveDraft = async () => {
    setIsSaving(true);
    setSaveError(null);

    // Validate client & email
    if (!clientId) {
      setSaveError("Please select or specify a valid client.");
      setIsSaving(false);
      return;
    }
    if (!recipientEmail || !recipientEmail.includes("@")) {
      setSaveError("A valid recipient email address is required.");
      setIsSaving(false);
      return;
    }
    if (!dueDate) {
      setSaveError("A due date is required.");
      setIsSaving(false);
      return;
    }
    if (dueDate < invoiceDate) {
      setSaveError("Due date must be on or after the invoice date.");
      setIsSaving(false);
      return;
    }
    if (lineItems.length === 0 || lineItems.some((li) => !li.description.trim())) {
      setSaveError("All line items must have a description.");
      setIsSaving(false);
      return;
    }
    if (
      lineItems.some(
        (li) =>
          !li.unitPriceDollars ||
          isNaN(parseFloat(li.unitPriceDollars)) ||
          parseFloat(li.unitPriceDollars) < 0
      )
    ) {
      setSaveError("All line items must have a valid non-negative unit price.");
      setIsSaving(false);
      return;
    }

    try {
      const payload = {
        clientId,
        title: title.trim(),
        notes: notes.trim(),
        terms: terms.trim(),
        currency: "USD",
        taxRateBasisPoints: Math.round(taxRatePercent * 100),
        invoiceDate,
        dueDate,
        lineItems: lineItems.map((li) => ({
          description: li.description.trim() || "Item",
          quantity: Math.max(parseInt(String(li.quantity), 10) || 1, 1),
          unitPriceMinorUnits: parseMoneyToMinorUnits(li.unitPriceDollars || "0") ?? 0,
        })),
      };

      const res = await fetch("/api/invoices/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const json = await res.json();
      if (res.ok && json.success) {
        onDraftSaved(json.data, json.data.materialPayloadHash);
      } else {
        setSaveError(json.error || "Failed to persist draft invoice.");
      }
    } catch {
      setSaveError("Network error while persisting draft invoice.");
    } finally {
      setIsSaving(false);
    }
  };

  const selectedClient = allClients.find((c) => c.id === clientId);

  const activeMissingFields = useMemo(() => {
    return missingFields.filter((f) => {
      if (f === "client" && clientId) return false;
      if (f === "recipientEmail" && recipientEmail && recipientEmail.includes("@")) return false;
      return true;
    });
  }, [missingFields, clientId, recipientEmail]);

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* Step Title & Back Action */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="font-headline font-bold text-2xl text-[#12263F]">
            Review Invoice Draft
          </h2>
          <p className="text-xs text-[#5E718D] mt-0.5">
            Verify client, line items, and terms. Missing information is flagged for your review.
          </p>
        </div>

        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[#E3E8EF] text-xs font-medium text-[#12263F] hover:bg-[#F6F5F1] transition-colors self-start sm:self-auto touch-target"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Edit description</span>
        </button>
      </div>

      {/* Attention Banner if missing fields exist */}
      {activeMissingFields.length > 0 && (
        <div className="p-4 rounded-xl bg-[#FEF9E7] border border-[#F3E0A2] text-[#7A5600] text-xs flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <span className="font-semibold text-[#12263F]">Attention needed on draft:</span>
            <p className="leading-relaxed">
              We flagged missing items ({activeMissingFields.join(", ")}). Please review or complete them before saving. CashPilot never guesses financial facts.
            </p>
          </div>
        </div>
      )}

      {/* Provenance Extraction Notice */}
      <div className="flex items-center gap-2 text-xs text-[#5E718D]">
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-[#F0EEFF] text-[#5B3FD0] border border-[#CDC4FF]">
          <Sparkles className="w-3 h-3" />
          <span>
            {extractionSource === "ai_model"
              ? `AI Drafted · ${modelName ?? "Gemini"}`
              : "Deterministic Rule-Based Extraction"}
          </span>
        </span>
        <span>·</span>
        <span>Not yet saved to database or PayPal</span>
      </div>

      {saveError && (
        <div className="p-3.5 rounded-xl bg-[#FEF3F2] border border-[#FECDCA] text-[#B42318] text-xs">
          {saveError}
        </div>
      )}

      {/* Two-Column Synchronized Layout (Desktop) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Editable Form Fields (7 cols) */}
        <div className="lg:col-span-7 space-y-5 rounded-2xl bg-white border border-[#E3E8EF] p-5 sm:p-6 shadow-xs">
          {/* Client Selection */}
          <div className="space-y-3 pb-4 border-b border-[#EEF2F6]">
            <div className="flex items-center justify-between">
              <label htmlFor="client-select" className="text-xs font-semibold text-[#12263F]">
                Client & Recipient
              </label>
              {activeMissingFields.includes("client") && (
                <span className="text-[10px] font-semibold text-[#B4440B] px-1.5 py-0.2 rounded bg-[#FDF2EB] border border-[#F7C4A5]">
                  Needs your input
                </span>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label htmlFor="client-select" className="block text-[11px] text-[#5E718D]">
                    Select Workspace Client
                  </label>
                  <button
                    type="button"
                    onClick={() => setIsQuickAddOpen(true)}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#0C7C61] hover:text-[#09634E] hover:underline transition-colors touch-target"
                  >
                    <Plus className="w-3.5 h-3.5 stroke-[2.5]" aria-hidden="true" />
                    <span>+ Create new client</span>
                  </button>
                </div>
                <select
                  id="client-select"
                  value={clientId}
                  onChange={(e) => handleClientChange(e.target.value)}
                  className="w-full p-2.5 rounded-xl border border-[#E3E8EF] text-xs bg-[#F6F5F1]/30 focus:border-[#0C7C61] focus:ring-1 focus:ring-[#0C7C61]"
                >
                  <option value="" disabled={Boolean(clientId)}>
                    {allClients.length === 0
                      ? "-- No clients in workspace --"
                      : "-- Select a workspace client --"}
                  </option>
                  {allClients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.company ? `${c.name} (${c.company})` : c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="recipient-email" className="block text-[11px] text-[#5E718D] mb-1">
                  Recipient Email (Locked on approval)
                </label>
                <input
                  id="recipient-email"
                  type="email"
                  value={recipientEmail}
                  onChange={(e) => setRecipientEmail(e.target.value)}
                  placeholder="accounts@client.com"
                  className="w-full p-2.5 rounded-xl border border-[#E3E8EF] text-xs bg-[#F6F5F1]/30 font-mono focus:border-[#0C7C61] focus:ring-1 focus:ring-[#0C7C61]"
                  required
                />
              </div>
            </div>
          </div>

          {/* Title and Dates */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pb-4 border-b border-[#EEF2F6]">
            <div>
              <label htmlFor="invoice-title" className="block text-[11px] text-[#5E718D] mb-1">
                Invoice Title
              </label>
              <input
                id="invoice-title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full p-2 rounded-xl border border-[#E3E8EF] text-xs bg-[#F6F5F1]/30"
              />
            </div>

            <div>
              <label htmlFor="invoice-date" className="block text-[11px] text-[#5E718D] mb-1">
                Issued Date
              </label>
              <input
                id="invoice-date"
                type="date"
                value={invoiceDate}
                onChange={(e) => setInvoiceDate(e.target.value)}
                className="w-full p-2 rounded-xl border border-[#E3E8EF] text-xs font-mono bg-[#F6F5F1]/30"
              />
            </div>

            <div>
              <label htmlFor="invoice-due-date" className="block text-[11px] text-[#5E718D] mb-1">
                Due Date
              </label>
              <input
                id="invoice-due-date"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="w-full p-2 rounded-xl border border-[#E3E8EF] text-xs font-mono bg-[#F6F5F1]/30"
              />
            </div>
          </div>

          {/* Line Items Builder */}
          <div className="space-y-3 pb-4 border-b border-[#EEF2F6]">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-[#12263F]">Line Items</h3>
              <button
                type="button"
                onClick={handleAddLineItem}
                className="inline-flex items-center gap-1 text-xs text-[#0C7C61] hover:underline font-medium"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Item</span>
              </button>
            </div>

            <div className="space-y-2">
              {lineItems.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-2 p-2.5 rounded-xl bg-[#F6F5F1]/40 border border-[#E3E8EF]"
                >
                  <input
                    type="text"
                    value={item.description}
                    onChange={(e) => handleUpdateLineItem(item.id, "description", e.target.value)}
                    placeholder="Description"
                    className="flex-1 p-2 rounded-lg border border-[#E3E8EF] text-xs bg-white"
                  />

                  <div className="w-16">
                    <input
                      type="number"
                      min={1}
                      value={item.quantity}
                      onChange={(e) => handleUpdateLineItem(item.id, "quantity", parseInt(e.target.value, 10) || 1)}
                      className="w-full p-2 rounded-lg border border-[#E3E8EF] text-xs text-center font-mono bg-white"
                      title="Quantity"
                    />
                  </div>

                  <div className="w-24">
                    <input
                      type="text"
                      value={item.unitPriceDollars}
                      onChange={(e) => handleUpdateLineItem(item.id, "unitPriceDollars", e.target.value)}
                      placeholder="0.00"
                      className="w-full p-2 rounded-lg border border-[#E3E8EF] text-xs text-right font-mono tabular-nums bg-white"
                      title="Unit Price USD"
                    />
                  </div>

                  <button
                    type="button"
                    onClick={() => handleRemoveLineItem(item.id)}
                    disabled={lineItems.length <= 1}
                    className="p-2 text-[#8A9BA8] hover:text-[#B42318] disabled:opacity-30 transition-colors"
                    aria-label="Remove line item"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Tax Rate & Terms */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="tax-rate" className="block text-[11px] text-[#5E718D] mb-1">
                Tax Rate (%)
              </label>
              <input
                id="tax-rate"
                type="number"
                min={0}
                max={50}
                value={taxRatePercent}
                onChange={(e) => setTaxRatePercent(parseFloat(e.target.value) || 0)}
                className="w-full p-2 rounded-xl border border-[#E3E8EF] text-xs font-mono bg-[#F6F5F1]/30"
              />
            </div>

            <div>
              <label htmlFor="invoice-terms" className="block text-[11px] text-[#5E718D] mb-1">
                Payment Terms
              </label>
              <input
                id="invoice-terms"
                type="text"
                value={terms}
                onChange={(e) => setTerms(e.target.value)}
                className="w-full p-2 rounded-xl border border-[#E3E8EF] text-xs bg-[#F6F5F1]/30"
              />
            </div>
          </div>

          {/* Notes */}
          <div>
            <label htmlFor="invoice-notes" className="block text-[11px] text-[#5E718D] mb-1">
              Notes / Instructions
            </label>
            <textarea
              id="invoice-notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full p-2 rounded-xl border border-[#E3E8EF] text-xs bg-[#F6F5F1]/30"
            />
          </div>

          {/* Form Submit Action */}
          <div className="pt-4 border-t border-[#EEF2F6] flex justify-end">
            <button
              type="button"
              onClick={handleSaveDraft}
              disabled={isSaving}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-[#0C7C61] hover:bg-[#096851] text-white text-xs font-semibold shadow-xs transition-colors touch-target focus-visible:ring-2 focus-visible:ring-[#0C7C61]"
            >
              {isSaving ? (
                <>
                  <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  <span>Saving draft...</span>
                </>
              ) : (
                <>
                  <FileCheck className="w-4 h-4" />
                  <span>Save Draft & Review Approval</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </>
              )}
            </button>
          </div>
        </div>

        {/* Right Column: Live Synchronized Invoice Preview (5 cols) */}
        <div className="lg:col-span-5 sticky top-20 rounded-2xl bg-white border border-[#E3E8EF] p-5 sm:p-6 shadow-md space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-[#EEF2F6]">
            <span className="text-[11px] font-semibold tracking-wider uppercase text-[#5E718D]">
              Live Document Preview
            </span>
            <span className="font-mono text-[10px] px-2 py-0.5 rounded-full bg-[#F4F6F8] text-[#5E718D] border border-[#E3E8EF]">
              Draft Preview
            </span>
          </div>

          {/* Invoice Header */}
          <div className="space-y-1">
            <h3 className="font-headline font-bold text-lg text-[#12263F]">{title || "Invoice"}</h3>
            <p className="text-xs text-[#5E718D]">
              Issued to: <strong className="text-[#12263F]">{selectedClient?.name || "Unassigned"}</strong>
            </p>
            <p className="text-[11px] text-[#5E718D] font-mono">{recipientEmail || "No email"}</p>
          </div>

          {/* Dates Bar */}
          <div className="grid grid-cols-2 gap-2 p-2.5 rounded-xl bg-[#F6F5F1] text-xs font-mono">
            <div>
              <span className="text-[10px] text-[#5E718D] block">Date:</span>
              <span>{invoiceDate}</span>
            </div>
            <div>
              <span className="text-[10px] text-[#5E718D] block">Due:</span>
              <span className="font-semibold text-[#12263F]">{dueDate}</span>
            </div>
          </div>

          {/* Items Summary Table */}
          <div className="border border-[#EEF2F6] rounded-xl overflow-hidden">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#F6F5F1] text-[10px] text-[#5E718D] uppercase border-b border-[#EEF2F6]">
                <tr>
                  <th className="p-2">Item</th>
                  <th className="p-2 text-center">Qty</th>
                  <th className="p-2 text-right">Price</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EEF2F6]">
                {lineItems.map((li) => (
                  <tr key={li.id}>
                    <td className="p-2 text-[#12263F] truncate max-w-[140px]">{li.description}</td>
                    <td className="p-2 text-center font-mono text-[#5E718D]">{li.quantity}</td>
                    <td className="p-2 text-right font-mono tabular-nums text-[#12263F]">
                      ${parseFloat(li.unitPriceDollars || "0").toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Financial Totals */}
          <div className="pt-2 space-y-1.5 text-xs">
            <div className="flex justify-between text-[#5E718D]">
              <span>Subtotal:</span>
              <span className="font-mono tabular-nums">{formatMoney(financialTotals.subtotalMinorUnits, currency)}</span>
            </div>

            {financialTotals.taxMinorUnits > 0 && (
              <div className="flex justify-between text-[#5E718D]">
                <span>Tax ({taxRatePercent}%):</span>
                <span className="font-mono tabular-nums">{formatMoney(financialTotals.taxMinorUnits, currency)}</span>
              </div>
            )}

            <div className="flex justify-between pt-2 border-t border-[#EEF2F6] font-bold text-sm text-[#12263F]">
              <span>Total Due:</span>
              <span className="font-mono tabular-nums text-base text-[#0C7C61]">
                {formatMoney(financialTotals.totalMinorUnits, currency)}
              </span>
            </div>
            <p className="text-[10px] text-[#5E718D] text-right italic pt-0.5">
              Totals are calculated by the app, never by AI.
            </p>
          </div>
        </div>
      </div>

      {/* Quick-add Client Modal */}
      <ClientFormModal
        isOpen={isQuickAddOpen}
        onClose={() => setIsQuickAddOpen(false)}
        onSuccess={handleQuickAddSuccess}
      />
    </div>
  );
}
