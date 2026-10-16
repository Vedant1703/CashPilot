# CashPilot AI — Wireframe and Screen Reference

**Purpose:** A textual companion to the visual wireframes, intended to help the coding agent understand the expected screen coverage. The original `CashPilot AI Wireframes.pdf` remains the visual reference and should be committed alongside this file if available.

## Design implementation rules

- Follow the supplied wireframes before inventing new flows.
- Prefer a consistent, restrained financial-workspace interface over a generic chatbot landing page.
- Keep money, currency, recipient, due date, current status, last-sync state, and approval details legible.
- Distinguish fixture/demo data, AI proposals, and PayPal-verified records.
- Every asynchronous operation needs appropriate loading, success, error, stale, and unknown-outcome states.
- Core workflows must work at 360 CSS pixels as well as desktop widths.
- Use semantic HTML, accessible labels, keyboard navigation, and visible focus.

## Screen inventory

### 1. Dashboard / overview
Purpose: show the current receivables picture and surface what needs attention.

Expected content:
- Receivables summary/metrics based on persisted records.
- Invoices needing attention and clear next steps.
- A visible distinction between demo fixtures and provider-backed records.
- Useful navigation to the collections board and invoice detail.
- Loading, empty, stale, and error states.

### 2. Collections board
Purpose: make the invoice lifecycle visible and help the user prioritize follow-up.

Expected behavior:
- Group invoices into normalized lifecycle columns.
- Cards show identifying invoice/client information, amount/currency, due date, and state.
- Filters/search may help narrow the board.
- Moving cards must not bypass server-side business rules or approval.
- Raw provider status must not be conflated with CashPilot's normalized state.
- Unknown/unmapped status should be visible for review, not silently mapped to Paid.

### 3. Invoice detail
Purpose: present the invoice record and its operational history.

Expected content:
- Client/recipient, line items, totals, currency, dates, and terms as applicable.
- CashPilot workflow status and raw/last-observed provider status.
- Provider reference and last-sync timestamp where available.
- Related recommendations and activity history.
- Actions enabled only when the current state and authorization permit them.

### 4. New invoice — describe
Purpose: let the user describe an invoice in natural language.

Expected behavior:
- Accept the user's invoice request.
- Explain which information is missing if clarification is required.
- Provide a manual-entry fallback if AI is unavailable.
- Treat the text as untrusted input; it cannot change application policies or authorize operations.

### 5. New invoice — review/edit
Purpose: turn AI output into a valid user-reviewed invoice.

Expected content:
- Structured editable fields and line items.
- Explicit currency, due date, recipient, quantity, and unit price.
- Deterministic totals computed by application code.
- Field-level validation and clear errors.
- No execution merely because the AI draft was generated.

### 6. Approve and send
Purpose: obtain explicit approval of a consequential action.

Before confirmation, show the exact material payload, including recipient, amount, currency, line items, and dates as relevant. Approval must be bound to this payload/version. If a material value changes, require a fresh approval. The backend must revalidate approval and authorization immediately before execution.

### 7. Send outcomes
Provide distinct, honest outcomes:
- Confirmed success with provider reference.
- Confirmed rejection/failure.
- Pending/unknown outcome after timeout or ambiguous response.

A timeout does not prove failure. Do not blindly retry an uncertain write; reconcile first. Never show success before the backend/provider result supports it. A successful send does not mean the invoice is paid.

### 8. AI copilot
Purpose: answer questions about receivables and explain recommendations.

Expected behavior:
- Ground answers in persisted invoice facts.
- Cite concrete facts such as due date, known status, amount, or time since due where available.
- Avoid unsupported collection-probability predictions or guaranteed cash-flow claims.
- AI output is a proposal, not an authoritative financial status or executed action.
- Validate structured output and handle model timeout/invalid responses.

### 9. Reminder draft and approval
Purpose: help prepare a suitable client follow-up without autonomous sending.

Expected behavior:
- Draft a reminder based on the selected invoice and relevant facts.
- Let the user edit the message.
- Show recipient and action details before approval.
- Execute only after explicit approval and only if provider/account/invoice state supports it.
- Record approval, attempt, result, and any reconciliation in activity history.

### 10. Refresh / reconcile
Purpose: update the local view using provider-observed state.

Expected behavior:
- Retrieve provider state where supported.
- Show last refresh time and source.
- On refresh failure, preserve the last valid status and mark it stale.
- Keep raw provider status separate from normalized state.
- Unknown or unmapped state must not become Paid.

### 11. Activity history
Purpose: make consequential operations explainable and auditable.

Include events for relevant approvals, attempts, outcomes, and reconciliations. Avoid logging credentials, tokens, or unnecessary personal data. The history should help a reviewer connect user intent to approval, provider operation, and observed outcome.

### 12. Clients
Purpose: maintain the minimum contact data needed for invoices and provider-supported notifications. Keep client data scoped to the workspace and send only the minimum necessary context to the AI model.

### 13. Error / degraded states
Design explicit states for:
- AI unavailable, timeout, or invalid structured output.
- PayPal authentication/API failure.
- Provider timeout or unknown write outcome.
- Stale status because refresh failed.
- Validation errors.
- Empty dashboard/board.
- Missing or unsupported provider capability.

Offer safe recovery steps without falsely claiming success or encouraging a duplicate write.

### 14. Mobile layout
The core journey should remain usable at 360 CSS pixels. Preserve key invoice facts and approval details; avoid hiding important financial context behind hover-only interactions.

## Primary end-to-end screen path

1. Dashboard → describe a new invoice.
2. Generate draft → review/edit structured fields.
3. Approve exact invoice payload → execute PayPal Sandbox operation.
4. Show observed result/provider reference.
5. Open collections board and invoice detail.
6. Inspect an overdue invoice → ask copilot for explanation.
7. Review/edit reminder draft → approve → execute if supported.
8. Refresh provider state and inspect activity history.

## Important note

This file is a textual implementation guide, not a replacement for the visual wireframes. Keep the original wireframe PDF in the repository, for example at `docs/design/CashPilot_AI_Wireframes.pdf`, so the agent and human contributors can inspect the intended visual layout.
