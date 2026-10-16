---
trigger: model_decision
description: Apply when changing PayPal, AI provider, database or other external integration code in CashPilot.
---


---
trigger: model_decision
description: "Apply when changing PayPal, AI provider, database or other external integration code in CashPilot."
---

# External Integration Rules

- Keep external API calls behind server-side adapters.
- Never expose secrets, OAuth tokens or private credentials to the browser.
- Validate current provider documentation and response schemas.
- Apply finite request timeouts and map errors into safe application errors.
- Validate external responses before changing persisted state.
- Persist provider resource IDs and safe request correlation references.
- Handle rate limits, validation failures, timeouts and unknown outcomes.
- Do not blindly retry an uncertain external write.
- Use idempotency mechanisms where supported and reconcile before unsafe retries.
- Keep provider-specific status mapping in one tested module.
- Preserve the last known valid status and mark data stale when refresh fails.
- Use Sandbox credentials and test accounts for the hackathon.
- Never use production credentials for demo testing.
- Never log secrets, access tokens or unnecessary personal information.
- Test integrations with mocked responses and real Sandbox smoke tests where possible.
  