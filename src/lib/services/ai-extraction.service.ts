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
  aiDraftId?: string;
  isInvoiceIntent: boolean;
  rejectionReason?: string;
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
 * Fast pre-flight heuristic to determine whether user input possesses plausible billing/invoice intent.
 * Short-circuits casual banter, trivia, coding requests, and gibberish in <1ms without calling AI.
 */
export function hasBillingIntent(
  inputText: string,
  knownClients: Array<{ name: string; company?: string | null }> = []
): { hasIntent: boolean; reason?: string } {
  const trimmed = inputText.trim();
  const lower = trimmed.toLowerCase();

  // 1. Extreme brevity
  if (trimmed.length < 5) {
    return {
      hasIntent: false,
      reason: "Please provide a more descriptive invoice request (e.g., client name, services, and amount).",
    };
  }

  // 2. Gibberish / low-entropy / punctuation spam
  const alphaChars = trimmed.replace(/[^a-zA-Z]/g, "");
  if (alphaChars.length < 3) {
    return {
      hasIntent: false,
      reason: "Your request does not contain recognizable words or invoice details.",
    };
  }

  // Check for unspaced long gibberish strings
  if (!trimmed.includes(" ") && trimmed.length > 14) {
    return {
      hasIntent: false,
      reason: "Your request appears to be unspaced or unrecognized text.",
    };
  }

  // 3. Known client match in prompt
  const hasKnownClient = knownClients.some((c) => {
    const cName = c.name.toLowerCase();
    const cComp = (c.company || "").toLowerCase();
    return (
      (cName.length >= 3 && lower.includes(cName)) ||
      (cComp.length >= 3 && lower.includes(cComp))
    );
  });

  // 4. Financial & invoice keywords
  const billingKeywords =
    /\b(bill|invoice|invoicing|charge|charged|fee|fees|retainer|deposit|consulting|hours|hrs|unit price|tax rate|net\s*\d+|due\s+date|due\s+in|due\s+on|payable|reimbursement|deliverable|deliverables|milestone|services?)\b/i;
  const currencyOrPrice = /\$\s*\d+|\b\d+\s*(?:dollars?|usd|cents?)\b|\b\d+(?:,\d{3})*(?:\.\d{2})?\s*(?:per\s+hour|\/hr|each)\b/;

  const hasBillingTerm = billingKeywords.test(lower);
  const hasCurrencyOrPrice = currencyOrPrice.test(lower) || /\$\d+/.test(lower);

  // If prompt has known client OR billing term OR price indicator, consider candidate for billing
  const hasAnyPositiveSignal = hasKnownClient || hasBillingTerm || hasCurrencyOrPrice;

  // 5. Out-of-domain patterns (casual questions, coding, trivia, recipes, weather)
  const isQuestionOrBanter =
    /^(?:what|who|where|when|why|how)\s+(?:is|are|was|were|do|does|did|can|could|would|the)\b/i.test(
      lower
    ) ||
    /\b(weather|forecast|joke|poem|song|recipe|capital of|president of|meaning of life|translate|reverse a string|algorithm|write\s+(?:a\s+)?(?:python|javascript|code|script|essay|story)|order\s+(?:pizza|food|burger))\b/i.test(
      lower
    ) ||
    /^(?:hello|hi|hey|good\s+(?:morning|afternoon|evening)|howdy)\b[!.?]*$/i.test(lower);

  // If it matches an out-of-domain question/banter and lacks strong billing terms, reject
  if (isQuestionOrBanter && !hasCurrencyOrPrice && !hasKnownClient) {
    return {
      hasIntent: false,
      reason: "This request appears to be a general question or command rather than an invoice or billing description.",
    };
  }

  if (!hasAnyPositiveSignal) {
    return {
      hasIntent: false,
      reason: "No billing terms, client name, service description, or price were found in this request.",
    };
  }

  return { hasIntent: true };
}

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
  isInvoiceIntent: boolean;
  rejectionReason?: string;
} {
  const missingFields: string[] = [];
  const text = inputText.toLowerCase();

  // 0. Pre-flight intent check
  const intentCheck = hasBillingIntent(inputText, knownClients);
  if (!intentCheck.hasIntent) {
    return {
      draft: {
        isInvoiceIntent: false,
        rejectionReason: intentCheck.reason,
        currency: "USD",
        clarificationRequired: true,
        missingFields: ["client", "lineItems", "dueDate"],
      },
      matchedClient: null,
      missingFields: ["client", "lineItems", "dueDate"],
      isAmbiguousClient: false,
      isInvoiceIntent: false,
      rejectionReason: intentCheck.reason,
    };
  }

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

  // 2. Line Items, Quantities & Rates (Support multi-item extraction, comma amounts like $1,250, and flexible phrasing)
  const lineItems: Array<{
    description: string;
    quantity: number;
    unitPriceDecimal: string;
  }> = [];

  const priceRegexStr = "\\$?(\\d{1,3}(?:,\\d{3})*(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)";

  // Strategy A: Parenthesized items: "Website redesign (10 hours at USD 150/hour), UI revisions (5 hours at USD 80/hour)"
  const parenRegex =
    /([A-Za-z0-9\s&./_-]+?)\s*\(\s*(\d+)\s*(?:hours|hrs|items|units|licenses|x)?\s*(?:at|@|for)?\s*(?:USD|\$)?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*(?:\/|\s*per|\s*each|\s*a)?\s*(?:hour|hr|item|unit|license)?\s*\)/gi;
  let pMatch: RegExpExecArray | null;
  while ((pMatch = parenRegex.exec(inputText)) !== null) {
    let desc = pMatch[1].trim();
    desc = desc.replace(
      /^(?:create\s+an?\s+invoice\s+for|invoice\s+for|bill\s+to|bill|invoice)\s+[^:]+:\s*/i,
      ""
    );
    desc = desc.replace(/^[\s,;:-]+/, "").trim();
    if (desc && !/^(?:net|tax|due)/i.test(desc)) {
      lineItems.push({
        description: desc.charAt(0).toUpperCase() + desc.slice(1),
        quantity: Math.max(parseInt(pMatch[2], 10), 1),
        unitPriceDecimal: parseFloat(pMatch[3].replace(/,/g, "")).toFixed(2),
      });
    }
  }

  // Strategy B: Colon / bullet format: "Website redesign: 10 hours at USD 150/hour"
  if (lineItems.length === 0) {
    const colonRegex =
      /([A-Za-z0-9\s&./_-]+?)\s*:\s*(\d+)\s*(?:hours|hrs|items|units|licenses|x)?\s*(?:at|@)\s*(?:USD|\$)?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?:\s*(?:\/|per|each|a)\s*(?:hour|hr|item|unit|license))?/gi;
    let cMatch: RegExpExecArray | null;
    while ((cMatch = colonRegex.exec(inputText)) !== null) {
      let desc = cMatch[1].trim().replace(/^[\s,;:-]+/, "").trim();
      if (desc && !/^(?:net|tax|due)/i.test(desc)) {
        lineItems.push({
          description: desc.charAt(0).toUpperCase() + desc.slice(1),
          quantity: Math.max(parseInt(cMatch[2], 10), 1),
          unitPriceDecimal: parseFloat(cMatch[3].replace(/,/g, "")).toFixed(2),
        });
      }
    }
  }

  // Strategy C: Multi qty-first items: "10 hours of website redesign at USD 150/hour, 5 hours of UI revisions at USD 80/hour"
  if (lineItems.length === 0) {
    const qtyFirstRegex =
      /(\d+)\s*(?:hours|hrs|items|units|licenses|x)?\s*(?:of\s*)?([^,.:\n]+?)\s*(?:at|@)\s*(?:USD|\$)?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?:\s*(?:\/|per|each|a)\s*(?:hour|hr|item|unit|license))?/gi;
    const qMatches: typeof lineItems = [];
    let qMatch: RegExpExecArray | null;
    while ((qMatch = qtyFirstRegex.exec(inputText)) !== null) {
      let desc = qMatch[2].trim().replace(/^[\s,;:-]+|and\s+/i, "").trim();
      if (desc && !/^(?:net|tax|due)/i.test(desc)) {
        qMatches.push({
          description: desc.charAt(0).toUpperCase() + desc.slice(1),
          quantity: Math.max(parseInt(qMatch[1], 10), 1),
          unitPriceDecimal: parseFloat(qMatch[3].replace(/,/g, "")).toFixed(2),
        });
      }
    }
    if (qMatches.length > 1) {
      lineItems.push(...qMatches);
    }
  }

  // Strategy D: Single-item patterns (if no multi-item patterns matched)
  if (lineItems.length === 0) {
    const hourlyMatch = inputText.match(
      new RegExp(
        "(\\d+)\\s*(?:hours|hrs|items|units|licenses|x)?\\s*(?:of\\s*)?([^,.]+?)\\s*(?:at|@)\\s*" +
          priceRegexStr +
          "(?:\\s*(?:\\/|per|each|a)\\s*(?:hour|hr|item|unit|license))?",
        "i"
      )
    );

    const fixedMatch = inputText.match(
      new RegExp(
        "(?:for\\s+|bill\\s+[^$]+?\\s+)?" + priceRegexStr + "\\s+(?:for|towards)\\s+([^,.]+)",
        "i"
      )
    );

    const billForAtMatch = inputText.match(
      new RegExp(
        "(?:bill|invoice|charge)\\s+[^$]+?\\s+for\\s+([^,.]+?)\\s+(?:at|@)\\s*" + priceRegexStr,
        "i"
      )
    );

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
  }

  // Check if after parsing there is any substance (line item or client candidate)
  const hasSubstance = lineItems.length > 0 || !!matchedClient || (!!candidateRaw && candidateRaw.length > 2);
  if (!hasSubstance) {
    const reason = "Could not identify any invoice line items, amounts, or clients in this request.";
    return {
      draft: {
        isInvoiceIntent: false,
        rejectionReason: reason,
        currency: "USD",
        clarificationRequired: true,
        missingFields: ["client", "lineItems", "dueDate"],
      },
      matchedClient: null,
      missingFields: ["client", "lineItems", "dueDate"],
      isAmbiguousClient: false,
      isInvoiceIntent: false,
      rejectionReason: reason,
    };
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

  // Check for "net 14" / "net 30" / "payment due in 14 days" / "due in X days"
  const netMatch =
    text.match(/(?:payment\s+)?due\s+(?:in|within)\s+(\d+)\s+days?/i) ||
    text.match(/net\s*(\d+)/i) ||
    text.match(/payable\s+within\s+(\d+)\s+days?/i) ||
    text.match(/terms(?:\s*of)?\s*[:\-]?\s*(\d+)\s*days?/i);
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

  let notes = `Drafted from request: "${inputText}"`;
  const customNoteMatch = inputText.match(/(?:note|memo|po\s*#?|po):\s*["']?([^"'\n]+)["']?/i);
  const thankYouMatch = inputText.match(
    /(?:with|and|include|add)?\s*(?:a\s+)?(?:professional|friendly|warm|polite)?\s*thank(?:s|\s*-\s*you|\s+you)\s*note/i
  );
  if (customNoteMatch && customNoteMatch[1]?.trim()) {
    notes = customNoteMatch[1].trim();
  } else if (thankYouMatch) {
    notes = "Thank you for your business. We appreciate the opportunity to work with you!";
  }

  const draft: AiInvoiceDraft = {
    isInvoiceIntent: true,
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
    isInvoiceIntent: true,
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

  // 2. Pre-flight intent classification: reject non-billing queries in <1ms without AI/DB overhead
  const preflightCheck = hasBillingIntent(inputText, knownClients);
  if (!preflightCheck.hasIntent) {
    return {
      aiDraftId: undefined,
      isInvoiceIntent: false,
      rejectionReason: preflightCheck.reason,
      source: "deterministic_rule_based",
      modelName: "cashpilot-intent-gate-v1",
      extractedDraft: {
        isInvoiceIntent: false,
        rejectionReason: preflightCheck.reason,
        currency: "USD",
        clarificationRequired: true,
        missingFields: ["client", "lineItems", "dueDate"],
      },
      matchedClient: null,
      missingFields: ["client", "lineItems", "dueDate"],
      clarificationMessage: preflightCheck.reason,
      explanation: preflightCheck.reason || "Input was rejected by CashPilot intent guardrail.",
    };
  }

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

  // 3. Attempt real AI if configured
  if (env && isAiConfigured(env) && env.AI_PROVIDER === "google") {
    const activeEnv = env;
    try {
      const knownClientsSummary =
        knownClients.length > 0
          ? JSON.stringify(
              knownClients.map((c) => ({
                id: c.id,
                name: c.name,
                company: c.company || undefined,
                email: c.email,
              }))
            )
          : "None recorded in workspace yet";

      const systemInstruction = `You are CashPilot AI, a financial invoice extraction assistant.
Evaluate the user prompt and extract structured invoice data into valid JSON matching this schema:
{
  "isInvoiceIntent": boolean,
  "rejectionReason": string (required if isInvoiceIntent is false, explaining why),
  "clientName": string (optional),
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

WORKSPACE CONTEXT:
Known Clients: ${knownClientsSummary}

CRITICAL RULES:
1. Intent Classification:
   - If the user's input is NOT an invoice, billing, payment request, or description of services/hours rendered (e.g. general questions, weather, jokes, programming requests, casual chat, food orders, or gibberish), you MUST set "isInvoiceIntent": false and explain in "rejectionReason".
   - Do NOT invent fictional line items, clients, or fake services for non-billing requests.
2. Grounded Extraction:
   - If "isInvoiceIntent" is true, match client to Known Clients if possible.
   - Extract ALL individual line items mentioned in the request. Do NOT combine multiple line items into one. Every distinct deliverable, service, or hourly task must be its own object in "lineItems" with exact description, quantity, and unitPriceDecimal.
   - If the user requests a thank-you note or custom message (e.g. "with a professional thank-you note", "friendly thank-you note"), put a complete, courteous customer-facing message in "notes". Do NOT truncate with ellipsis ("...").
   - Calculate "dueDate" based on payment terms if specified (e.g. 14 days from today's date ${new Date().toISOString().substring(0, 10)}).
   - Never guess or fabricate missing email addresses or dates. Flag them in "missingFields".
   - Authoritative totals will be calculated by the server, not you.
3. Return raw JSON only.`;

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

  // 4. Handle LLM rejection if Gemini determined the request was not billing intent
  if (rawOutput && rawOutput.isInvoiceIntent === false) {
    const rejReason =
      (rawOutput.rejectionReason as string) ||
      "The request does not appear to describe an invoice or billing request.";
    return {
      aiDraftId: undefined,
      isInvoiceIntent: false,
      rejectionReason: rejReason,
      source: "ai_model",
      modelName,
      extractedDraft: {
        isInvoiceIntent: false,
        rejectionReason: rejReason,
        currency: "USD",
        clarificationRequired: true,
        missingFields: ["client", "lineItems", "dueDate"],
      },
      matchedClient: null,
      missingFields: ["client", "lineItems", "dueDate"],
      clarificationMessage: rejReason,
      explanation: rejReason,
    };
  }

  // 5. Fallback to deterministic extraction if AI was not used or failed
  let detResult: ReturnType<typeof extractInvoiceDeterministically> | null = null;
  if (!rawOutput) {
    detResult = extractInvoiceDeterministically(inputText, knownClients);
    if (!detResult.isInvoiceIntent) {
      return {
        aiDraftId: undefined,
        isInvoiceIntent: false,
        rejectionReason: detResult.rejectionReason,
        source: "deterministic_rule_based",
        modelName: "deterministic-rule-engine-v1",
        extractedDraft: detResult.draft,
        matchedClient: null,
        missingFields: detResult.missingFields,
        clarificationMessage: detResult.rejectionReason,
        explanation: detResult.rejectionReason || "Could not identify billing intent in request.",
      };
    }
    rawOutput = detResult.draft as unknown as Record<string, unknown>;
    source = "deterministic_rule_based";
    modelName = "deterministic-rule-engine-v1";
    explanation = "Extracted using CashPilot deterministic pattern engine (AI credentials not configured or offline).";
  }

  // 6. Validate output with Zod on the server (Treat AI output as untrusted input)
  const parsed = aiInvoiceDraftSchema.safeParse(rawOutput);
  let extractedDraft: AiInvoiceDraft;

  if (parsed.success) {
    extractedDraft = parsed.data;
  } else {
    // If model returned invalid structure, fall back to deterministic parsing
    detResult = extractInvoiceDeterministically(inputText, knownClients);
    if (!detResult.isInvoiceIntent) {
      return {
        aiDraftId: undefined,
        isInvoiceIntent: false,
        rejectionReason: detResult.rejectionReason,
        source: "deterministic_rule_based",
        modelName: "deterministic-rule-engine-v1",
        extractedDraft: detResult.draft,
        matchedClient: null,
        missingFields: detResult.missingFields,
        clarificationMessage: detResult.rejectionReason,
        explanation: detResult.rejectionReason || "Could not identify billing intent in request.",
      };
    }
    extractedDraft = detResult.draft;
    source = "deterministic_rule_based";
    explanation = "AI output failed schema validation. Replaced with verified deterministic pattern extraction.";
  }

  // If parsed output indicates non-invoice intent, return early
  if (extractedDraft.isInvoiceIntent === false) {
    const rejReason =
      extractedDraft.rejectionReason || "Input was identified as non-invoice request.";
    return {
      aiDraftId: undefined,
      isInvoiceIntent: false,
      rejectionReason: rejReason,
      source,
      modelName,
      extractedDraft,
      matchedClient: null,
      missingFields: extractedDraft.missingFields || ["client", "lineItems", "dueDate"],
      clarificationMessage: rejReason,
      explanation: rejReason,
    };
  }

  // 7. Match with known workspace client (unambiguous only)
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

  // 8. Persist AiDraft record in database only for legitimate invoice proposals (SRS §4 & §6)
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
      promptVersion: "1.1",
      reviewStatus: AiDraftReviewStatus.PENDING,
    },
  });

  return {
    aiDraftId: aiDraftRecord.id,
    isInvoiceIntent: true,
    source,
    modelName,
    extractedDraft,
    matchedClient,
    missingFields,
    clarificationMessage,
    explanation,
  };
}
