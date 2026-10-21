/**
 * CashPilot AI — AI Invoice Extraction Service
 *
 * SRS §4: Natural language invoice draft extraction
 * AI Governance Invariants:
 *   - AI output is UNTRUSTED INPUT.
 *   - Strictly validates all model responses against Zod schemas on the server.
 *   - Missing information is explicitly flagged, never hallucinated or guessed.
 *   - Never lets model output calculate authoritative totals or execute PayPal writes.
 *   - Gracefully falls back to deterministic rule-based pattern extraction when AI_API_KEY is unconfigured or offline.
 *   - Clearly labels extraction source so mock/deterministic fallback is never disguised as real AI.
 */

import { db } from "@/lib/db/client";
import { getServerEnv, isAiConfigured } from "@/lib/env";
import {
  aiInvoiceDraftSchema,
  type AiInvoiceDraft,
} from "@/lib/validations/invoice";
import { Prisma, AiDraftReviewStatus } from "@prisma/client";

export interface ExtractionResult {
  aiDraftId: string;
  source: "ai_model" | "deterministic_rule_based";
  modelName: string;
  extractedDraft: AiInvoiceDraft;
  matchedClient: {
    id: string;
    name: string;
    email: string;
    company?: string | null;
  } | null;
  missingFields: string[];
  clarificationMessage?: string;
  explanation: string;
}

/**
 * Deterministic pattern extraction engine.
 * Used when AI_API_KEY is not configured or as safe fallback.
 * Accurately parses standard client names, hourly/fixed rates, quantities, and due dates.
 */
export function extractInvoiceDeterministically(
  inputText: string,
  knownClients: Array<{ id: string; name: string; email: string; company?: string | null }> = []
): {
  draft: AiInvoiceDraft;
  matchedClient: (typeof knownClients)[0] | null;
  missingFields: string[];
} {
  const missingFields: string[] = [];
  const text = inputText.toLowerCase();

  // 1. Client matching (first against known clients, then regex extraction from text)
  let matchedClient: (typeof knownClients)[0] | null = null;
  for (const client of knownClients) {
    const cName = client.name.toLowerCase();
    const cCompany = client.company?.toLowerCase() ?? "";
    if (text.includes(cName) || (cCompany && text.includes(cCompany))) {
      matchedClient = client;
      break;
    }
  }

  let clientName = matchedClient?.name;
  if (!clientName) {
    const clientMatch = inputText.match(/(?:create an invoice for|invoice for|bill to|bill|invoice)\s+([A-Z][A-Za-z0-9\s&.'-]+?)(?:\s+(?:for|dated|with|\$|net)|,|$)/i);
    if (clientMatch) {
      clientName = clientMatch[1].trim();
    }
  }

  if (!clientName) {
    missingFields.push("client");
  }

  // Check for email in prompt if no client matched
  let recipientEmail = matchedClient?.email;
  if (!recipientEmail) {
    const emailMatch = inputText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (emailMatch) {
      recipientEmail = emailMatch[0];
    } else {
      missingFields.push("recipientEmail");
    }
  }

  // 2. Line Items, Quantities & Rates
  const lineItems: Array<{
    description: string;
    quantity: number;
    unitPriceDecimal: string;
  }> = [];

  // Pattern 1: "X hours ... at $Y / for $Y"
  const hourlyMatch = inputText.match(/(\d+)\s*(?:hours|hrs)\s*(?:of\s*)?([^,.]+?)\s*(?:at|@)\s*\$?(\d+(?:\.\d{1,2})?)/i);
  // Pattern 2: "for $Y ... retainer/package/consulting"
  const fixedMatch = inputText.match(/(?:for|bill\s+[^$]+?)\s*\$?(\d+(?:\.\d{1,2})?)\s*(?:for\s+)?([^,.]+)/i);

  if (hourlyMatch) {
    const qty = parseInt(hourlyMatch[1], 10);
    const desc = hourlyMatch[2].trim() || "Consulting Services";
    const price = parseFloat(hourlyMatch[3]).toFixed(2);
    lineItems.push({
      description: desc.charAt(0).toUpperCase() + desc.slice(1),
      quantity: Math.max(qty, 1),
      unitPriceDecimal: price,
    });
  } else if (fixedMatch) {
    const price = parseFloat(fixedMatch[1]).toFixed(2);
    const desc = fixedMatch[2].trim() || "Professional Services";
    lineItems.push({
      description: desc.charAt(0).toUpperCase() + desc.slice(1),
      quantity: 1,
      unitPriceDecimal: price,
    });
  } else {
    // Generic fallback line item
    const priceMatch = inputText.match(/\$(\d+(?:\.\d{1,2})?)/);
    if (priceMatch) {
      lineItems.push({
        description: "Professional Services",
        quantity: 1,
        unitPriceDecimal: parseFloat(priceMatch[1]).toFixed(2),
      });
    } else {
      missingFields.push("lineItems");
    }
  }

  // 3. Tax Rate
  let taxRatePercent: number | undefined;
  const taxMatch = text.match(/(\d+(?:\.\d+)?)\s*%\s*tax/i) || text.match(/tax\s*(?:rate)?\s*(?:of)?\s*(\d+(?:\.\d+)?)\s*%/i);
  if (taxMatch) {
    taxRatePercent = parseFloat(taxMatch[1]);
  }

  // 4. Due Date & Terms Parsing
  let dueDate: string | undefined;
  let terms: string | undefined;
  const now = new Date();

  // Check for "net 14" / "net 30" / "due in X days"
  const netMatch = text.match(/net\s*(\d+)/i) || text.match(/due\s+in\s+(\d+)\s+days?/i);
  if (netMatch) {
    const days = parseInt(netMatch[1], 10);
    const d = new Date(now.getTime() + days * 86400000);
    dueDate = d.toISOString().substring(0, 10);
    terms = `Net ${days} days`;
  } else {
    // Check for explicit date like "due November 4, 2026" or "due 2026-11-04"
    const explicitDate = text.match(/due\s+(?:on\s+)?([a-z]+\s+\d{1,2}(?:st|nd|rd|th)?,?\s*\d{4}|\d{4}-\d{2}-\d{2})/i);
    if (explicitDate) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(explicitDate[1])) {
        dueDate = explicitDate[1];
      } else {
        const parsed = Date.parse(explicitDate[1].replace(/(st|nd|rd|th)/, ""));
        if (!isNaN(parsed)) {
          const d = new Date(parsed);
          const year = d.getFullYear();
          const month = String(d.getMonth() + 1).padStart(2, "0");
          const day = String(d.getDate()).padStart(2, "0");
          dueDate = `${year}-${month}-${day}`;
        }
      }
    }
  }

  // If due date was not in prompt, do NOT fabricate it; flag as missing per financial governance
  if (!dueDate) {
    missingFields.push("dueDate");
  }

  // 5. Title & Notes
  let title = "Professional Services Invoice";
  if (clientName) {
    title = `${clientName} Services`;
  }

  const draft: AiInvoiceDraft = {
    clientName,
    recipientEmail,
    title,
    currency: "USD",
    dueDate,
    taxRatePercent,
    terms,
    lineItems: lineItems.length > 0 ? lineItems : undefined,
    notes: `Drafted from request: "${inputText.substring(0, 100)}${inputText.length > 100 ? "..." : ""}"`,
    missingFields: missingFields.length > 0 ? missingFields : undefined,
    clarificationRequired: missingFields.length > 0,
  };

  return {
    draft,
    matchedClient,
    missingFields,
  };
}

/**
 * Extracts structured invoice fields from natural-language user prompt.
 */
export async function extractInvoiceFromPrompt(
  workspaceId: string,
  inputText: string,
  actorId: string = "demo-user-1"
): Promise<ExtractionResult> {
  // 1. Fetch existing clients for matching
  const knownClients = await db.client.findMany({
    where: { workspaceId },
    select: { id: true, name: true, email: true, company: true },
  });

  let env;
  try {
    env = getServerEnv();
  } catch {
    env = null;
  }

  let rawOutput: Record<string, unknown> | null = null;
  let source: "ai_model" | "deterministic_rule_based" = "deterministic_rule_based";
  let modelName = "deterministic-rule-engine-v1";
  let explanation = "Extracted using CashPilot deterministic pattern engine (AI credentials not configured).";

  // 2. Attempt real AI if configured
  if (env && isAiConfigured(env) && env.AI_PROVIDER === "google") {
    const activeEnv = env;
    try {
      const systemInstruction = `You are CashPilot AI, a financial invoice extraction assistant.
Extract structured invoice data from the user request into valid JSON matching this schema:
{
  "clientName": string,
  "recipientEmail": string (optional, only if provided),
  "title": string,
  "currency": "USD",
  "dueDate": "YYYY-MM-DD",
  "lineItems": [{ "description": string, "quantity": integer, "unitPriceDecimal": "0.00" }],
  "notes": string,
  "missingFields": string[]
}
Never guess missing email addresses or dates. If missing, add field name to missingFields. Return raw JSON only.`;

      const promptPayload = {
        contents: [
          {
            parts: [
              { text: systemInstruction },
              { text: `User invoice description: ${inputText}` },
            ],
          },
        ],
        generationConfig: {
          response_mime_type: "application/json",
          temperature: 0.1,
        },
      };

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${activeEnv.AI_MODEL}:generateContent?key=${activeEnv.AI_API_KEY}`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(promptPayload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (res.ok) {
        const json = await res.json();
        const candidateText = json.candidates?.[0]?.content?.parts?.[0]?.text;
        if (candidateText) {
          rawOutput = JSON.parse(candidateText);
          source = "ai_model";
          modelName = activeEnv.AI_MODEL;
          explanation = `Extracted via Google Gemini (${activeEnv.AI_MODEL}) with server-side schema verification.`;
        }
      }
    } catch {
      // Gracefully fall through to deterministic engine
    }
  }

  // 3. Fallback to deterministic extraction if AI was not used or failed
  if (!rawOutput) {
    const det = extractInvoiceDeterministically(inputText, knownClients);
    rawOutput = det.draft as unknown as Record<string, unknown>;
    source = "deterministic_rule_based";
    modelName = "deterministic-rule-engine-v1";
    explanation = "Extracted using CashPilot deterministic pattern engine (AI credentials not configured or offline).";
  }

  // 4. Validate output with Zod on the server (Treat AI output as untrusted input)
  const parsed = aiInvoiceDraftSchema.safeParse(rawOutput);
  let extractedDraft: AiInvoiceDraft;

  if (parsed.success) {
    extractedDraft = parsed.data;
  } else {
    // If model returned invalid structure, fall back to deterministic parsing
    const det = extractInvoiceDeterministically(inputText, knownClients);
    extractedDraft = det.draft;
    source = "deterministic_rule_based";
    explanation = "AI output failed schema validation. Replaced with verified deterministic pattern extraction.";
  }

  // 5. Match with known workspace client
  let matchedClient: (typeof knownClients)[0] | null = null;
  if (extractedDraft.clientName) {
    const qName = extractedDraft.clientName.toLowerCase();
    matchedClient =
      knownClients.find(
        (c) =>
          c.name.toLowerCase() === qName ||
          c.name.toLowerCase().includes(qName) ||
          qName.includes(c.name.toLowerCase())
      ) ?? null;
  }

  if (matchedClient && !extractedDraft.recipientEmail) {
    extractedDraft.recipientEmail = matchedClient.email;
  }

  // Calculate remaining missing fields
  const missingFields: string[] = [];
  if (!extractedDraft.recipientEmail) missingFields.push("recipientEmail");
  if (!extractedDraft.dueDate) missingFields.push("dueDate");
  if (!extractedDraft.lineItems || extractedDraft.lineItems.length === 0) missingFields.push("lineItems");
  if (!matchedClient && !extractedDraft.clientName) missingFields.push("client");

  // Clarification notice
  let clarificationMessage: string | undefined;
  if (missingFields.length > 0) {
    clarificationMessage = `Attention: ${missingFields.join(", ")} needed. CashPilot will not guess missing financial facts.`;
  }

  // 6. Persist AiDraft record in database for traceability (SRS §4 & §6)
  const aiDraftRecord = await db.aiDraft.create({
    data: {
      workspaceId,
      inputText,
      structuredOutput: JSON.parse(JSON.stringify(extractedDraft)) as Prisma.InputJsonValue,
      evidenceSources: {
        ...(matchedClient ? { matchedClientId: matchedClient.id } : {}),
        actorId,
      } as Prisma.InputJsonValue,
      modelName,
      promptVersion: "1.0",
      reviewStatus: AiDraftReviewStatus.PENDING,
    },
  });

  return {
    aiDraftId: aiDraftRecord.id,
    source,
    modelName,
    extractedDraft,
    matchedClient,
    missingFields,
    clarificationMessage,
    explanation,
  };
}
