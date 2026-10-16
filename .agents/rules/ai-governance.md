---
trigger: always_on
---


---
trigger: always_on
description: "CashPilot AI output validation, evidence grounding, privacy, prompt injection defense and human approval boundaries."
---

# AI Governance Rules

- AI may interpret, structure, summarize, rank and propose actions.
- AI must not directly execute PayPal operations or authorize itself.
- Validate all model output against a strict schema on the server.
- Treat prompts, model output and retrieved text as untrusted input.
- Use persisted invoice facts as the source of truth for recommendations.
- Explain recommendations using specific, verifiable evidence.
- Ask for clarification when material information is missing or ambiguous.
- Never let AI output determine authoritative invoice totals or payment status.
- Expose only narrowly scoped, typed and allowlisted application tools.
- Authorize every tool operation independently on the server.
- Do not send secrets, access tokens, payment credentials or unrelated client data to the model.
- Keep a manual invoice-entry fallback when AI is unavailable.
- Handle model timeouts, invalid output and provider errors explicitly.
- Never present generated content as an executed or provider-confirmed action.
  