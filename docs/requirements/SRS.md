# CashPilot AI — Software Requirements Specification (Agent Reference)

**Source baseline:** CASH-SRS-001, version 1.0, dated 11 October 2026  
**Status in source:** Draft for implementation baseline; product, engineering, and QA review approvals were pending.  
**Purpose of this file:** A concise, searchable Markdown implementation reference. It is not a verbatim replacement for the complete original 24-page SRS.

## 1. Purpose and scope

CashPilot AI is a web application for freelancers and small service businesses to draft/manage client invoices, view receivables by lifecycle stage on a Kanban board, receive explainable AI recommendations, prepare payment reminders, and observe verified PayPal invoice status changes.

The MVP is sandbox-first. PayPal is authoritative for provider-side invoice/payment status. CashPilot is authoritative for its own workflow, approval, recommendation, and audit records. Local-only changes must never be represented as completed PayPal payments.

### In scope
- One authenticated workspace for the primary hackathon demo, with workspace ownership modeled so it can be enforced.
- Client/contact records required for invoices and PayPal-supported notifications.
- Natural-language invoice drafting into structured, editable line items with validation, currency, and due-date handling.
- PayPal Invoicing API integration for draft creation, approved sending, retrieval/listing of status where supported, and reminders where provider/account/invoice state permits.
- Dashboard, collections Kanban, invoice detail, refresh/synchronization, AI recommendations, approval checkpoints, activity history, and recoverable error states.
- Clear distinction between demo/test fixtures and provider-confirmed records; server-side secrets.

### Out of scope for MVP
- Live-money/production processing, custody, escrow, lending, credit decisions, or autonomous financial decisions.
- Full accounting, tax filing/advice, payroll, bank aggregation, or accounting-platform reconciliation.
- Unsupervised sending, automatic discounts/escalation, or AI-initiated provider operations without user approval.
- Collection-probability prediction, fraud scoring, or guaranteed cash-flow forecasts.
- Multi-currency portfolio analytics, complex partial-payment allocation, bulk invoicing, and external CRM/accounting integrations unless scope is explicitly changed.

## 2. User classes and environment

- **Workspace owner:** manages clients/invoices, reviews recommendations, approves actions, and inspects history.
- **Demo evaluator/judge:** follows a documented demo path without access to provider secrets.
- **Maintainer/developer:** configures Sandbox credentials, AI key, deployment, and tests.
- **External AI model:** interprets intent and generates drafts/recommendations; it cannot call PayPal directly or bypass server controls.
- **PayPal:** provider-side invoice operations and status.

Target modern desktop and mobile browsers; the responsive layout must work down to 360 CSS pixels. The expected system includes a web frontend, server-side API/service tier, relational database, AI inference endpoint, and PayPal Sandbox REST API. When an integration is unavailable, persisted state may be shown only with a clear stale/last-known indicator.

## 3. Mandatory engineering constraints

- PayPal is central: the demo must make real authenticated requests to PayPal Sandbox for a core invoice lifecycle action. A static button or mocked provider response alone is insufficient.
- AI is central: structured invoice drafting and/or context-grounded recommendations/reminder generation must be implemented; a generic chatbot wrapper is insufficient.
- Production mode must be disabled by default and must not be enabled by a UI toggle.
- Financial amounts must use fixed-precision decimal or integer minor units, never binary floating-point arithmetic.
- Consequential external actions require specific approval of the previewed action.
- Provider capability, account eligibility, currency, notification behavior, API response contracts, and event/webhook availability must be checked against current PayPal documentation and the actual Sandbox account.

## 4. Functional requirements — implementation checklist

Use these as feature groups and turn each into testable tickets. For exact original requirement IDs, priorities, and acceptance criteria, consult the complete source SRS.

### Workspace and clients
- Provide an authenticated primary workspace for the demo.
- Store client/contact information required to draft and send invoices.
- Enforce server-side workspace ownership and authorization for all reads/writes.
- Clearly identify seed/demo fixtures.

### Invoice drafting and editing
- Accept a natural-language invoice request.
- Produce schema-validated structured data, including client/recipient, line items, quantities, unit prices, currency, dates, and relevant description/terms.
- Ask for clarification when material information is missing or ambiguous; do not invent facts.
- Let the user inspect and edit fields before approval.
- Validate all fields server-side before persistence or provider calls.
- Compute authoritative totals in deterministic application code.
- Preserve currency and monetary precision.

### Approval and execution
- Present a review step before consequential actions.
- Bind approval to the exact material payload, including relevant recipient, line items/amount, currency, dates, and action.
- If a material field changes, invalidate the approval and require review again.
- Revalidate authorization and approval immediately before executing the server-side operation.
- AI output must never execute a provider operation or authorize itself.
- Record approval, attempts, outcomes, and reconciliation in activity/audit history.

### PayPal integration and reconciliation
- Keep OAuth credentials/tokens and API calls server-side.
- Use documented PayPal Sandbox endpoints and validate response schemas.
- Persist provider invoice IDs and safe correlation references.
- Retrieve provider state to reconcile local views.
- Separate raw provider status from CashPilot’s normalized workflow status.
- Only verified provider evidence may establish Paid.
- A successful send is not a payment.
- Unknown, stale, or unmapped provider states must not become Paid.
- If a write times out, its outcome is unknown; reconcile before retrying.
- Avoid duplicate invoice/reminder operations; use idempotency mechanisms where supported.
- Preserve the last valid status and mark it stale if refresh fails.
- Map provider failures into safe, actionable application errors.

### AI copilot and recommendations
- Ground recommendations in persisted invoice/client facts and relevant status/due-date evidence.
- Explain why an invoice is prioritized with specific, verifiable evidence.
- Generate editable reminder drafts.
- Treat model output, prompts, client descriptions, and retrieved text as untrusted.
- Validate model output against strict server-side schemas.
- Use narrow, typed, allowlisted tools and authorize each operation independently.
- Never send secrets, tokens, payment credentials, or unrelated client data to the model.
- Keep a manual invoice-entry fallback when AI is unavailable.
- Show model failure/timeout/invalid output states explicitly.
- Never label generated text as sent or provider-confirmed.

### Collections board, dashboard, and activity
- Provide an overview/dashboard, invoice list, Kanban board, invoice detail, and activity history.
- Show normalized workflow state and provider state without conflating them.
- Show last refresh/sync time and stale state when appropriate.
- Drag-and-drop must not bypass state-transition or approval rules.
- Do not show success until the backend/provider result supports it.
- Provide visible loading, empty, success, stale, and error states.
- Clearly distinguish fixtures, AI proposals, and PayPal-verified records.

## 5. Status and financial truth

The source documents name these user-facing lifecycle categories where appropriate to verified data:

- **Draft**
- **Awaiting Payment**
- **Due Soon**
- **Overdue**
- **Paid**
- **Cancelled**
- **Needs Review**

Do not assume this list is a one-to-one copy of PayPal’s raw status enum. Define a centralized, tested mapping from provider status plus relevant dates/context to CashPilot state. Keep raw provider status separately. Unknown/unmapped states should be represented as unknown/needs review, never silently treated as paid.

A status refresh failure should preserve the last known valid state and mark it stale. The UI should communicate that the data could not be refreshed.

## 6. Data model — conceptual entities

The implementation should model, at minimum, the concepts below. Exact schema and field names remain implementation decisions.

- **Workspace/User:** owner and authorization boundary.
- **Client:** recipient/contact information needed for invoicing.
- **Invoice:** workspace/client references, currency, line items, dates, deterministic totals, local workflow state, raw provider status, provider invoice ID, and sync metadata.
- **Invoice line item:** description, quantity, unit price, and deterministic line total.
- **AI draft/recommendation:** structured proposal, relevant evidence/source facts, creation time, and review status.
- **Approval:** actor, action type, exact material payload or stable hash/version, approval time, and invalidation status.
- **External operation:** operation type, idempotency/correlation reference where supported, attempt state, timestamps, and safe result/error metadata.
- **Activity/audit event:** actor/system source, action, target entity, approval reference, provider operation reference, outcome, and timestamp.

Do not store credentials or access tokens in ordinary business records or logs.

## 7. Non-functional requirements and quality gates

### Security and privacy
- Keep PayPal credentials, AI keys, and tokens server-side.
- Do not commit real secrets.
- Enforce authorization server-side for every consequential operation.
- Minimize model context and avoid unnecessary personal data.
- Treat user-provided descriptions and external content as untrusted input.
- Avoid logging secrets, tokens, or unnecessary personal information.

### Reliability
- Apply finite timeouts to external calls.
- Treat timed-out writes as unknown outcomes.
- Reconcile uncertain writes before retrying.
- Do not invent success when a provider request fails.
- Keep integration failures recoverable and visible.

### Usability and accessibility
- Support desktop and mobile layouts down to 360 CSS pixels.
- Use semantic HTML, accessible labels, keyboard navigation, and visible focus.
- Display loading, empty, success, stale, and error states.
- Keep the exact action details visible during approval.

### Maintainability
- Prefer a focused modular application over microservices.
- Centralize provider status mapping and integration adapters.
- Test business rules independently from external systems.
- Document environment setup and local execution.

## 8. Required end-to-end workflow

1. User enters an invoice request in natural language.
2. AI returns a structured proposal; server validates schema and fields.
3. Application computes totals deterministically and persists an editable draft.
4. User reviews and edits the draft.
5. The system displays the exact action payload and requests approval.
6. Server revalidates authorization, approval, and payload version.
7. Backend calls PayPal Sandbox and persists the provider reference/result.
8. UI reports the observed outcome; a send result is not treated as payment.
9. Provider status is retrieved/refreshed and mapped into CashPilot state.
10. Activity history records approval, operation attempt/result, and reconciliation.

For reminders, follow the same prepare → review → approve → execute → record pattern, only where the provider and invoice state support the operation.

## 9. Acceptance and regression scenarios

- **Straightforward invoice:** known client, clear amount and due date; draft requires minimal correction.
- **Ambiguous request:** missing recipient or unclear price basis; ask for clarification instead of inventing values.
- **Overdue invoice:** explain urgency using the due date and known status; prepare a polite reminder.
- **Disputed invoice:** flag human review and avoid an insensitive default reminder.
- **Provider failure:** API rejects or times out; no false success and no unsafe duplicate on retry.
- **Stale state:** status refresh fails; preserve last known state, show stale indicator, do not infer payment.
- **Prompt injection:** malicious client text cannot change system policies or trigger disallowed tools.
- **Approval invalidation:** edit a material field after approval; execution must be blocked until re-approved.
- **Payload binding:** executed payload must match the approved payload.
- **Payment truth:** no path marks Paid without verified provider evidence.
- **Audit:** approval, execution attempt, outcome, and reconciliation are traceable.
- **Responsive behavior:** critical flows remain usable at 360 CSS pixels.

## 10. Risks and mitigations

| Risk | Required mitigation |
|---|---|
| Sandbox account lacks an invoicing capability | Prove required operations early; document constraints; never call mocked behavior provider-confirmed. |
| AI invents fields or inappropriate language | Structured schema, validation, editable drafts, source facts, explicit approval. |
| Incorrect/stale payment state | Separate provider/local states, last-sync time, reconciliation, fail closed on unknown. |
| Duplicate operation after retry | Persist operation references, use idempotency where supported, reconcile after timeout. |
| Scope grows | Finish one complete path before optional analytics/integrations. |
| Demo/network instability | Repeatable setup, Sandbox test data, safe failure path, honestly labeled fixtures. |
| Secret leakage | Environment variables, placeholders only, repository scanning, rotate exposed credentials. |
| Recommendations lack value | Test real tasks and refine action explanations rather than adding generic chat features. |

## 11. Suggested implementation order

1. Prove PayPal Sandbox authentication, create draft, send, and retrieve/status.
2. Implement persistence, client/invoice records, normalized statuses, Kanban, filters, and activity.
3. Add structured AI invoice drafting, evidence-grounded recommendations, and reminder drafts.
4. Implement exact-payload approval, server-side execution, safe retry, and reconciliation.
5. Complete responsive/error/empty states, tests, README, license, and reproducible demo.

## 12. Open decisions that must be recorded

- AI provider and structured-output/tool-calling approach.
- Hosting and relational database provider.
- Authentication approach for the demo.
- PayPal account capabilities, permissions, supported currencies, reminder eligibility, and current API response contracts.
- Availability of webhooks/events versus refresh/polling for the MVP.
- Exact status mapping and unknown-state handling.
- Single-currency assumption and precision rules.
- Demo deployment and seed-data strategy.

## 13. Source references

The original SRS identifies these references; verify current documentation before relying on provider-specific behavior:

- ISO/IEC/IEEE 29148:2018 requirements-engineering reference: https://www.iso.org/standard/72089.html
- PayPal Invoicing v2 API: https://developer.paypal.com/api/invoicing/v2/
- PayPal Invoicing quick start: https://developer.paypal.com/api/invoicing
- PayPal send invoice: https://developer.paypal.com/api/invoicing/v2/invoices-send/
- PayPal Sandbox testing: https://developer.paypal.com/sandbox-testing/overview/
- PayPal REST API requests: https://developer.paypal.com/api/rest/requests/

This Markdown file condenses the source SRS. For original requirement IDs, full acceptance tables, detailed traceability, and any omitted sections, use the complete original SRS.
