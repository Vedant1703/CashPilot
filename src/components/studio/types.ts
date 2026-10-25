/**
 * CashPilot AI — Invoice Studio Types
 */

export interface PersistedStudioInvoice {
  id: string;
  number?: string | null;
  workspaceId: string;
  clientId: string;
  title: string;
  status: string;
  currency: string;
  subtotalMinorUnits: number;
  taxMinorUnits: number;
  totalMinorUnits: number;
  taxRateBasisPoints: number;
  invoiceDate: string | Date;
  dueDate: string | Date;
  notes?: string | null;
  terms?: string | null;
  client?: {
    id: string;
    name: string;
    email: string;
    company?: string | null;
  } | null;
  lineItems?: Array<{
    id: string;
    description: string;
    quantity: number;
    unitPriceMinorUnits: number;
    lineTotalMinorUnits: number;
  }>;
}

export interface PayPalDraftResult {
  operationId?: string;
  isExistingDraft?: boolean;
  paypalInvoiceId: string;
  paypalStatus?: string;
  status?: string;
  invoiceId?: string;
  isUnknownOutcome?: boolean;
}

export interface ExtractionResponseData {
  aiDraftId: string;
  source: "ai_model" | "deterministic_rule_based";
  modelName: string;
  extractedDraft?: {
    clientName?: string;
    clientReference?: string;
    clientId?: string;
    recipientEmail?: string;
    title?: string;
    currency?: string;
    invoiceDate?: string;
    dueDate?: string;
    lineItems?: Array<{
      description: string;
      quantity: number;
      unitPriceDecimal?: string;
      unitPriceDollars?: string;
    }>;
    taxRatePercent?: number;
    notes?: string;
    terms?: string;
    missingFields?: string[];
    clarificationRequired?: boolean;
  };
  extractedFields?: {
    clientName?: string;
    clientReference?: string;
    clientId?: string;
    recipientEmail?: string;
    title?: string;
    invoiceDate?: string;
    dueDate?: string;
    currency?: string;
    lineItems?: Array<{
      description: string;
      quantity: number;
      unitPriceDollars?: string;
      unitPriceDecimal?: string;
    }>;
    taxRatePercent?: number;
    notes?: string;
    terms?: string;
  };
  matchedClient?: {
    id: string;
    name: string;
    email: string;
    company?: string | null;
  } | null;
  missingFields: string[];
  confidence?: number;
  reasoning?: string;
  clarificationMessage?: string;
  explanation?: string;
}
