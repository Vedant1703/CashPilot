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
/**
 * Unambiguously matches a client candidate name or prompt text against known workspace clients.
 * Normalizes common corporate suffixes (Inc, LLC, Corp, etc.) for flexible matching.
 * Returns null if no match or if multiple matches exist (ambiguous match).
 */
export function matchClientAgainstKnown(
  candidateName: string | undefined,
  rawText: string,
  knownClients: Array<{ id: string; name: string; email: string; company?: string | null }> = []
): { matchedClient: (typeof knownClients)[0] | null; isAmbiguous: boolean } {
  if (!knownClients || knownClients.length === 0) {
    return { matchedClient: null, isAmbiguous: false };
  }

  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "")
      .replace(/\b(inc|corporation|corp|llc|co|company|ltd|associates)\b/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const text = rawText.toLowerCase();

  // 1. If candidateName is provided, evaluate it first
  if (candidateName && candidateName.trim().length > 0) {
    const cand = candidateName.trim().toLowerCase();
    const candNorm = normalize(cand);

    // Direct match against candidateName
    const directMatches = knownClients.filter((c) => {
      const cName = c.name.toLowerCase();
      const cComp = (c.company || "").toLowerCase();
      return (
        cName === cand ||
        cComp === cand ||
        cName.includes(cand) ||
        cComp.includes(cand) ||
        cand.includes(cName) ||
        (cComp && cand.includes(cComp))
      );
    });

    if (directMatches.length === 1) {
      return { matchedClient: directMatches[0], isAmbiguous: false };
    }
    if (directMatches.length > 1) {
      return { matchedClient: null, isAmbiguous: true };
    }

    // Base name match (ignoring Inc, Corp, etc.)
    if (candNorm.length >= 3) {
      const baseMatches = knownClients.filter((c) => {
        const bName = normalize(c.name);
        const bComp = c.company ? normalize(c.company) : "";
        return (
          bName === candNorm ||
          bComp === candNorm ||
          (bName.length >= 3 && bName.includes(candNorm)) ||
          (bComp.length >= 3 && bComp.includes(candNorm)) ||
          (candNorm.length >= 3 && candNorm.includes(bName)) ||
          (bComp.length >= 3 && candNorm.includes(bComp))
        );
      });

      if (baseMatches.length === 1) {
        return { matchedClient: baseMatches[0], isAmbiguous: false };
      }
      if (baseMatches.length > 1) {
        return { matchedClient: null, isAmbiguous: true };
      }
    }
  }

  // 2. Search rawText directly against knownClients
  const directTextMatches = knownClients.filter((c) => {
    const cName = c.name.toLowerCase();
    const cComp = (c.company || "").toLowerCase();
    return text.includes(cName) || (cComp && text.includes(cComp));
  });

  if (directTextMatches.length === 1) {
    return { matchedClient: directTextMatches[0], isAmbiguous: false };
  }
  if (directTextMatches.length > 1) {
    return { matchedClient: null, isAmbiguous: true };
  }

  const baseTextMatches = knownClients.filter((c) => {
    const bName = normalize(c.name);
    const bComp = c.company ? normalize(c.company) : "";
    return (
      (bName.length >= 3 && text.includes(bName)) ||
      (bComp.length >= 3 && text.includes(bComp))
    );
  });

  if (baseTextMatches.length === 1) {
    return { matchedClient: baseTextMatches[0], isAmbiguous: false };
  }
  if (baseTextMatches.length > 1) {
    return { matchedClient: null, isAmbiguous: true };
  }

  return { matchedClient: null, isAmbiguous: false };
}

/**
 * Deterministic pattern-based invoice extraction engine.
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
  isAmbiguousClient: boolean;
} {
  const missingFields: string[] = [];
  const text = inputText.toLowerCase();

  // 1. Client matching against known clients
  const clientMatch = inputText.match(
    /(?:create an invoice for|invoice for|bill to|bill|invoice)\s+([A-Z][A-Za-z0-9\s&.'-]+?)(?:\s+(?:for|dated|with|\$|net)|,|$)/i
  );
  const candidateRaw = clientMatch ? clientMatch[1].trim() : undefined;

  const matchResult = matchClientAgainstKnown(candidateRaw, inputText, knownClients);
  const matchedClient = matchResult.matchedClient;
  const isAmbiguousClient = matchResult.isAmbiguous;

  const clientName = matchedClient?.name || candidateRaw;
  if (!matchedClient) {
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

  // 2. Line Items, Quantities & Rates (Support comma amounts like $1,250 and flexible phrasing)
  const lineItems: Array<{
    description: string;
    quantity: number;
    unitPriceDecimal: string;
  }> = [];

  const priceRegexStr = "\\$?(\\d{1,3}(?:,\\d{3})*(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)";

  // Pattern 1: Hourly / Quantity: "10 hours of system design consulting at $150 per hour" or "5 units at $20 each"
  const hourlyMatch = inputText.match(
    new RegExp(
      "(\\d+)\\s*(?:hours|hrs|items|units|licenses|x)?\\s*(?:of\\s*)?([^,.]+?)\\s*(?:at|@)\\s*" +
        priceRegexStr +
        "(?:\\s*(?:\\/|per|each|a)\\s*(?:hour|hr|item|unit|license))?",
      "i"
    )
  );

  // Pattern 2: "Bill TechStart $1,250 for sprint 3 frontend development" or "$1,250 for sprint 3 frontend development"
  const fixedMatch = inputText.match(
    new RegExp(
      "(?:for\\s+|bill\\s+[^$]+?\\s+)?" + priceRegexStr + "\\s+(?:for|towards)\\s+([^,.]+)",
      "i"
    )
  );

  // Pattern 3: "Bill Jane for consulting at $500"
  const billForAtMatch = inputText.match(
    new RegExp(
      "(?:bill|invoice|charge)\\s+[^$]+?\\s+for\\s+([^,.]+?)\\s+(?:at|@)\\s*" + priceRegexStr,
      "i"
    )
  );

  // Pattern 4: "for consulting at $500"
  const forAtMatch = inputText.match(
    new RegExp("(?:for\\s+)([^,.]+?)\\s+(?:at|@)\\s*" + priceRegexStr, "i")
  );

  if (hourlyMatch) {
    const qty = parseInt(hourlyMatch[1], 10);
    const desc = hourlyMatch[2].trim() || "Consulting Services";
    const cleanPrice = hourlyMatch[3].replace(/,/g, "");
    const price = parseFloat(cleanPrice).toFixed(2);
    lineItems.push({
      description: desc.charAt(0).toUpperCase() + desc.slice(1),
      quantity: Math.max(qty, 1),
      unitPriceDecimal: price,
    });
  } else if (fixedMatch && fixedMatch[2]?.trim()) {
    const cleanPrice = fixedMatch[1].replace(/,/g, "");
    const price = parseFloat(cleanPrice).toFixed(2);
    const desc = fixedMatch[2].trim();
    lineItems.push({
      description: desc.charAt(0).toUpperCase() + desc.slice(1),
      quantity: 1,
      unitPriceDecimal: price,
    });
  } else if (billForAtMatch && billForAtMatch[1]?.trim()) {
    const cleanPrice = billForAtMatch[2].replace(/,/g, "");
    const price = parseFloat(cleanPrice).toFixed(2);
    const desc = billForAtMatch[1].trim();
    lineItems.push({
      description: desc.charAt(0).toUpperCase() + desc.slice(1),
      quantity: 1,
      unitPriceDecimal: price,
    });
  } else if (forAtMatch && forAtMatch[1]?.trim()) {
    const cleanPrice = forAtMatch[2].replace(/,/g, "");
    const price = parseFloat(cleanPrice).toFixed(2);
    const desc = forAtMatch[1].trim();
    lineItems.push({
      description: desc.charAt(0).toUpperCase() + desc.slice(1),
      quantity: 1,
      unitPriceDecimal: price,
    });
  } else {
    // Generic fallback line item with standalone dollar amount
    const priceMatch = inputText.match(/\$(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/);
    if (priceMatch) {
      const cleanPrice = priceMatch[1].replace(/,/g, "");
      lineItems.push({
        description: "Professional Services",
        quantity: 1,
        unitPriceDecimal: parseFloat(cleanPrice).toFixed(2),
      });
    } else {
      missingFields.push("lineItems");
    }
  }

  // 3. Tax Rate
  let taxRatePercent: number | undefined;
  const taxMatch =
    text.match(/(\d+(?:\.\d+)?)\s*%\s*tax/i) ||
    text.match(/tax\s*(?:rate)?\s*(?:of)?\s*(\d+(?:\.\d+)?)\s*%/i) ||
    text.match(/with\s*(?:a\s*)?(\d+(?:\.\d+)?)\s*%\s*tax/i);
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
    // Check for explicit date like "due November 4, 2026", "due Nov 4, 2026", "due 2026-11-04", or "due Nov 4"
    const explicitDate = text.match(
      /due\s+(?:on\s+)?([a-z]+\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?|\d{4}-\d{2}-\d{2})/i
    );
    if (explicitDate) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(explicitDate[1])) {
        dueDate = explicitDate[1];
      } else {
        let rawDateStr = explicitDate[1].replace(/(st|nd|rd|th)/, "");
        if (!/\d{4}/.test(rawDateStr)) {
          rawDateStr += `, ${now.getFullYear()}`;
        }
        const parsed = Date.parse(rawDateStr);
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

  let notes = `Drafted from request: "${inputText.substring(0, 100)}${inputText.length > 100 ? "..." : ""}"`;
  const noteMatch = inputText.match(/(?:note|memo|po\s*#?|po):\s*([^,.\n]+)/i);
  if (noteMatch && noteMatch[1]?.trim()) {
    notes = noteMatch[1].trim();
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
    notes,
    missingFields: missingFields.length > 0 ? missingFields : undefined,
    clarificationRequired: missingFields.length > 0,
  };

  return {
    draft,
    matchedClient,
    missingFields,
    isAmbiguousClient,
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
  "taxRatePercent": number (optional, e.g. 10 for 10%),
  "terms": string (optional),
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
  let detResult: ReturnType<typeof extractInvoiceDeterministically> | null = null;
  if (!rawOutput) {
    detResult = extractInvoiceDeterministically(inputText, knownClients);
    rawOutput = detResult.draft as unknown as Record<string, unknown>;
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
    detResult = extractInvoiceDeterministically(inputText, knownClients);
    extractedDraft = detResult.draft;
    source = "deterministic_rule_based";
    explanation = "AI output failed schema validation. Replaced with verified deterministic pattern extraction.";
  }

  // 5. Match with known workspace client (unambiguous only)
  let matchedClient: ExtractionResult["matchedClient"] = null;
  let isAmbiguousClient = false;

  if (detResult) {
    matchedClient = detResult.matchedClient;
    isAmbiguousClient = detResult.isAmbiguousClient;
  } else {
    const matchRes = matchClientAgainstKnown(
      extractedDraft.clientName,
      inputText,
      knownClients
    );
    matchedClient = matchRes.matchedClient;
    isAmbiguousClient = matchRes.isAmbiguous;
  }

  if (matchedClient) {
    extractedDraft.clientName = matchedClient.name;
    if (!extractedDraft.recipientEmail) {
      extractedDraft.recipientEmail = matchedClient.email;
    }
  }

  // Calculate remaining missing fields
  const missingFields: string[] = [];
  if (!extractedDraft.recipientEmail) missingFields.push("recipientEmail");
  if (!extractedDraft.dueDate) missingFields.push("dueDate");
  if (!extractedDraft.lineItems || extractedDraft.lineItems.length === 0) missingFields.push("lineItems");
  if (!matchedClient) missingFields.push("client");

  // Clarification notice
  let clarificationMessage: string | undefined;
  if (isAmbiguousClient) {
    clarificationMessage = `Attention: Multiple clients match "${extractedDraft.clientName || "the request"}". Please select the intended client before proceeding.`;
  } else if (missingFields.length > 0) {
    clarificationMessage = `Attention: ${missingFields.join(", ")} needed. CashPilot will not guess missing financial facts.`;
  }

  extractedDraft.missingFields = missingFields.length > 0 ? missingFields : undefined;
  extractedDraft.clarificationRequired = missingFields.length > 0;

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
