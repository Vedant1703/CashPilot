"use client";

import React, { useState } from "react";
import Link from "next/link";
import { DescribeStep } from "./describe-step";
import { ReviewStep, EditableLineItem, ReviewDraftFormData } from "./review-step";
import { ApprovalModal } from "./approval-modal";
import { PayPalConfirmStep } from "./paypal-confirm-step";
import { Check, ChevronRight, FileText, Sparkles, Shield, Lock } from "lucide-react";
import { PersistedStudioInvoice, PayPalDraftResult, ExtractionResponseData } from "./types";

export type StudioStep = "DESCRIBE" | "REVIEW" | "APPROVE" | "CONFIRMED";

interface StudioWizardProps {
  knownClients: Array<{
    id: string;
    name: string;
    email: string;
    company?: string | null;
  }>;
}

export function StudioWizard({ knownClients }: StudioWizardProps) {
  const [currentStep, setCurrentStep] = useState<StudioStep>("DESCRIBE");
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractionError, setExtractionError] = useState<string | null>(null);

  // Review step state
  const [draftFormData, setDraftFormData] = useState<Partial<ReviewDraftFormData>>({});
  const [missingFields, setMissingFields] = useState<string[]>([]);
  const [extractionSource, setExtractionSource] = useState<"ai_model" | "deterministic_rule_based">("deterministic_rule_based");
  const [modelName, setModelName] = useState<string | undefined>(undefined);

  // Persisted state after saving draft
  const [persistedInvoice, setPersistedInvoice] = useState<PersistedStudioInvoice | null>(null);
  const [materialPayloadHash, setMaterialPayloadHash] = useState<string>("");

  // Confirmed PayPal result
  const [paypalResult, setPaypalResult] = useState<PayPalDraftResult | null>(null);

  // Step 1: Handle Extraction Success
  const handleDraftGenerated = (promptText: string, extractionResponse: ExtractionResponseData) => {
    setIsExtracting(false);
    setExtractionError(null);

    const fields = extractionResponse?.extractedFields ?? {};
    const missing = extractionResponse?.missingFields ?? [];

    // Map extracted line items to editable items with local IDs
    const mappedLineItems: EditableLineItem[] = (fields.lineItems ?? []).map((li, idx: number) => ({
      id: `item-${idx + 1}-${Date.now()}`,
      description: li.description || "Service",
      quantity: li.quantity || 1,
      unitPriceDollars: li.unitPriceDollars ? String(li.unitPriceDollars) : "150.00",
    }));

    setDraftFormData({
      clientId: fields.clientId || knownClients[0]?.id || "",
      recipientEmail: fields.recipientEmail || knownClients[0]?.email || "",
      title: fields.title || "Consulting & Professional Services",
      invoiceDate: fields.invoiceDate || new Date().toISOString().substring(0, 10),
      dueDate: fields.dueDate || new Date(Date.now() + 14 * 86400000).toISOString().substring(0, 10),
      currency: fields.currency || "USD",
      taxRatePercent: fields.taxRatePercent ?? 0,
      lineItems: mappedLineItems.length > 0 ? mappedLineItems : [
        {
          id: `item-1-${Date.now()}`,
          description: "Consulting Services",
          quantity: 1,
          unitPriceDollars: "150.00",
        },
      ],
      notes: fields.notes || `Prompt used: "${promptText}"`,
      terms: fields.terms || "Payment due within net terms.",
    });

    setMissingFields(missing);
    setExtractionSource(extractionResponse?.source ?? "deterministic_rule_based");
    setModelName(extractionResponse?.modelName);
    setCurrentStep("REVIEW");
  };

  // Step 1: Fallback to manual blank draft
  const handleManualDraftRequested = () => {
    setDraftFormData({
      clientId: knownClients[0]?.id || "",
      recipientEmail: knownClients[0]?.email || "",
      title: "Consulting Services",
      invoiceDate: new Date().toISOString().substring(0, 10),
      dueDate: new Date(Date.now() + 14 * 86400000).toISOString().substring(0, 10),
      currency: "USD",
      taxRatePercent: 0,
      lineItems: [
        {
          id: `item-1-${Date.now()}`,
          description: "Professional Services",
          quantity: 1,
          unitPriceDollars: "150.00",
        },
      ],
      notes: "",
      terms: "Payment due upon receipt or within net terms.",
    });
    setMissingFields([]);
    setExtractionSource("deterministic_rule_based");
    setModelName(undefined);
    setCurrentStep("REVIEW");
  };

  // Step 2: Handle Draft Saved on Server
  const handleDraftSaved = (savedInvoice: PersistedStudioInvoice, payloadHash: string) => {
    setPersistedInvoice(savedInvoice);
    setMaterialPayloadHash(payloadHash);
    setCurrentStep("APPROVE");
  };

  // Step 3: Handle PayPal Sandbox Draft Created
  const handlePayPalDraftCreated = (result: PayPalDraftResult) => {
    setPaypalResult(result);
    setCurrentStep("CONFIRMED");
  };

  // Reset to initial Describe Step
  const handleReset = () => {
    setCurrentStep("DESCRIBE");
    setDraftFormData({});
    setMissingFields([]);
    setPersistedInvoice(null);
    setMaterialPayloadHash("");
    setPaypalResult(null);
    setExtractionError(null);
  };

  // Progress Steps Definition
  const stepsConfig = [
    { id: "DESCRIBE", label: "1. Describe", icon: Sparkles },
    { id: "REVIEW", label: "2. Review Draft", icon: FileText },
    { id: "APPROVE", label: "3. Human Approval", icon: Lock },
    { id: "CONFIRMED", label: "4. PayPal Confirmed", icon: Shield },
  ];

  const getStepIndex = (step: StudioStep) => {
    switch (step) {
      case "DESCRIBE": return 0;
      case "REVIEW": return 1;
      case "APPROVE": return 2;
      case "CONFIRMED": return 3;
    }
  };

  const currentStepIndex = getStepIndex(currentStep);

  return (
    <div className="space-y-8">
      {/* Top Breadcrumb & Step Navigation */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-[#E3E8EF]">
        <div className="flex items-center gap-2 text-xs text-[#5E718D]">
          <Link href="/" className="hover:text-[#12263F] transition-colors">
            Dashboard
          </Link>
          <ChevronRight className="w-3.5 h-3.5 text-[#8A9BA8]" />
          <Link href="/collections" className="hover:text-[#12263F] transition-colors">
            Collections
          </Link>
          <ChevronRight className="w-3.5 h-3.5 text-[#8A9BA8]" />
          <span className="font-semibold text-[#12263F]">Invoice Studio</span>
        </div>

        {/* Step Progression Pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto py-1">
          {stepsConfig.map((s, idx) => {
            const isCompleted = idx < currentStepIndex;
            const isCurrent = idx === currentStepIndex;
            const Icon = s.icon;

            let pillStyles = "text-xs font-medium px-3 py-1.5 rounded-full flex items-center gap-1.5 transition-all ";
            if (isCurrent) {
              if (s.id === "APPROVE") {
                pillStyles += "bg-[#FDF2EB] text-[#B4440B] border border-[#F7C4A5] font-semibold shadow-xs";
              } else if (s.id === "CONFIRMED") {
                pillStyles += "bg-[#E8F5F1] text-[#0C7C61] border border-[#BCE3D6] font-semibold shadow-xs";
              } else {
                pillStyles += "bg-[#F0EEFF] text-[#5B3FD0] border border-[#CDC4FF] font-semibold shadow-xs";
              }
            } else if (isCompleted) {
              pillStyles += "bg-white text-[#0C7C61] border border-[#E3E8EF]";
            } else {
              pillStyles += "bg-white/60 text-[#8A9BA8] border border-transparent";
            }

            return (
              <div key={s.id} className="flex items-center gap-1.5">
                <div className={pillStyles}>
                  {isCompleted ? (
                    <Check className="w-3.5 h-3.5 text-[#0C7C61] stroke-[2.5]" />
                  ) : (
                    <Icon className="w-3.5 h-3.5" />
                  )}
                  <span className="whitespace-nowrap">{s.label}</span>
                </div>
                {idx < stepsConfig.length - 1 && (
                  <ChevronRight className="w-3 h-3 text-[#CBD5E1] shrink-0" />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Wizard Step Content Rendering */}
      {currentStep === "DESCRIBE" && (
        <DescribeStep
          onDraftGenerated={handleDraftGenerated}
          onManualDraftRequested={handleManualDraftRequested}
          isLoading={isExtracting}
          error={extractionError}
        />
      )}

      {currentStep === "REVIEW" && (
        <ReviewStep
          initialData={draftFormData}
          knownClients={knownClients}
          missingFields={missingFields}
          extractionSource={extractionSource}
          modelName={modelName}
          onBack={() => setCurrentStep("DESCRIBE")}
          onDraftSaved={handleDraftSaved}
        />
      )}

      {currentStep === "APPROVE" && persistedInvoice && (
        <ApprovalModal
          persistedInvoice={persistedInvoice}
          materialPayloadHash={materialPayloadHash}
          onBackToEdit={() => setCurrentStep("REVIEW")}
          onPayPalDraftCreated={handlePayPalDraftCreated}
        />
      )}

      {currentStep === "CONFIRMED" && persistedInvoice && (
        <PayPalConfirmStep
          persistedInvoice={persistedInvoice}
          paypalResult={paypalResult}
          onReset={handleReset}
        />
      )}
    </div>
  );
}
