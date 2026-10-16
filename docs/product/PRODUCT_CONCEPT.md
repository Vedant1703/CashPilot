# CashPilot AI — Problem Statement and Proposed Solution

**Document status:** Proposed product direction  
**Version represented:** 1.0, 13 October 2026  
**Purpose:** Explain why CashPilot exists, what it proposes to do, and how the hackathon demo should communicate its value.

## 1. Executive summary

Freelancers and small service businesses complete work, create invoices, wait for payment, and then spend time deciding when and how to follow up. Information is fragmented across client conversations, invoice records, calendars, payment-provider pages, email drafts, and personal memory. This creates avoidable administrative work, inconsistent follow-up, and poor visibility into which outstanding invoice needs attention next.

CashPilot AI proposes a single receivables workspace organized around the invoice lifecycle. Users can draft invoices from natural language, review and send them through PayPal-supported workflows, view invoice states on a Kanban board, and ask an AI copilot to explain priorities or prepare a client reminder.

Recommendations should be grounded in stored invoice facts and provider-confirmed status. Ordinary application logic—not the model—owns financial calculations and state changes. Consequential external actions require explicit user approval.

## 2. Product thesis

The opportunity is not simply to generate invoice text. It is to help a small business decide what to do next about money it is owed, prepare that action with context, and verify what happened through a connected payment workflow.

## 3. Problem to solve

The workflow between completing work and confidently managing collection is fragmented:

- The user has to assemble invoice and client information.
- The user has to remember due dates and decide which receivable needs attention.
- The user has to compose follow-up messages and navigate payment-provider tools.
- The user needs to distinguish a sent invoice from a paid invoice.
- The user needs a reliable record of what was approved, attempted, and confirmed.

CashPilot should connect these tasks into one coherent workflow rather than become a generic chatbot.

## 4. Target users

### Primary user
A freelancer or small service-business owner/operator who manages client invoices and collections without a dedicated finance team.

### Other stakeholders
- **Demo evaluator/judge:** should be able to follow the end-to-end workflow and understand where AI was used and how PayPal was used.
- **Maintainer/developer:** configures server-side credentials, deployment, and tests; secrets must never be exposed to the browser.

## 5. Proposed solution

CashPilot combines:

1. **Receivables overview:** dashboard metrics and the work that needs attention.
2. **Invoice workflow:** create, review, validate, approve, send, and refresh invoice status.
3. **Collections Kanban:** organize invoices by normalized lifecycle state.
4. **AI-assisted drafting:** convert a natural-language request into an editable structured invoice draft.
5. **AI copilot:** explain invoice priority using specific invoice facts and prepare reminder drafts.
6. **Approval checkpoints:** show the exact material parameters before a consequential action executes.
7. **PayPal Sandbox integration:** demonstrate actual provider-backed invoice operations where the account/API supports them.
8. **Activity history:** connect user intent, approval, operation attempt, provider result, and reconciliation.

## 6. Differentiation

The intended differentiator is the connection between receivables state and the next action:

- A spreadsheet can list invoices, but does not inherently connect the list to approved provider actions.
- An invoice tool can create and send invoices, but may not help the user prioritize several outstanding receivables.
- A generic chatbot can generate text, but is not authoritative for persisted invoice facts or payment status.
- Unrestricted automation can execute actions without review; CashPilot proposes explainable recommendations with human approval.

These are product-positioning hypotheses, not a comprehensive competitive analysis or validated customer outcome.

## 7. MVP scope

### Must deliver
- Responsive workspace with overview, invoice list, collections Kanban, invoice detail, AI copilot, and activity history.
- Small seed/demo dataset clearly distinguishable from provider-confirmed Sandbox records.
- Natural-language invoice drafting into an editable, validated structured form.
- PayPal Sandbox draft creation and sending, subject to confirmation of account capability and current API contract.
- Lifecycle states that distinguish Draft, Awaiting Payment, Due Soon, Overdue, Paid, Cancelled, and Needs Review as appropriate to verified provider data.
- Explainable AI recommendations and reminder drafts, with approval before sending.
- Status refresh/reconciliation and auditable action history, including failure and retry states.
- Public repository, license, setup instructions, safe environment-variable example, tests, and a demo of less than three minutes.

### Explicitly outside the MVP
- Production/live-money processing, custody of funds, escrow, lending, or financial advice.
- Replacing accounting, tax, payroll, legal, compliance, or bookkeeping systems.
- Autonomous invoice or reminder sending without approval.
- Bank integrations, broad multi-currency conversion, full accounting reconciliation, or ingestion of all email/chat histories.
- Unvalidated collection-probability prediction, credit scoring, fraud scoring, or guaranteed cash-flow forecasting.
- Complex multi-agent frameworks or microservices without a demonstrated MVP need.

## 8. Product principles

- **Human control:** AI proposes; the user approves consequential actions.
- **Verifiable financial truth:** provider status must be based on provider evidence.
- **Explainability:** recommendations cite relevant, verifiable invoice facts.
- **Deterministic calculations:** financial arithmetic and state transitions belong to application code.
- **Safe recovery:** a timeout is an uncertain outcome, not proof of failure.
- **Honest demos:** fixture/mock data must be labeled; mock results must never be presented as PayPal-confirmed.
- **Privacy and least privilege:** send the model only the minimum context needed.
- **Focused delivery:** prioritize one complete invoice-to-collection path over breadth.

## 9. Proposed validation signals

These are initial targets to validate, not proven results:

- A typical invoice can be drafted, corrected, and approved in one short workflow without editing raw JSON.
- All critical end-to-end demo scenarios pass repeatedly from a clean run.
- Recommendations use correct invoice facts and do not invent payment events.
- No tested path sends an invoice/reminder without approval bound to its current material parameters.
- No tested path marks an invoice Paid without provider evidence.
- AI/provider errors, timeouts, stale status, and invalid input have clear states and safe recovery.
- A viewer can explain the problem, AI contribution, approval checkpoint, and provider-confirmed outcome after the demo.

## 10. High-risk scenarios to validate

- **Ambiguous request:** ask for missing recipient, amount, or price basis rather than inventing values.
- **Overdue invoice:** explain urgency using the due date and known status; prepare a polite reminder draft.
- **Disputed invoice:** require human review and avoid an insensitive default reminder.
- **Provider timeout:** do not show false success or blindly create/send again.
- **Stale status:** show last-known status and timestamp; do not infer a new state.
- **Prompt injection in client text:** treat descriptions and retrieved content as untrusted data; they cannot change system policy or enable disallowed tools.

## 11. Recommended delivery sequence

1. **Validate PayPal Sandbox first:** prove token acquisition, draft creation, send, and retrieval/status with the intended account. Record limitations.
2. **Build data and board:** implement client/invoice records, normalized states, Kanban, filters, and activity log.
3. **Add AI:** structured invoice drafting, evidence-grounded recommendations, and reminder drafting.
4. **Connect approval to execution:** exact-payload approval, backend operations, safe retry, and reconciliation.
5. **Polish and release:** responsive states, documentation, tests, reproducible setup, and demo recording.

## 12. Three-minute demo narrative

| Time | Show | Intended message |
|---|---|---|
| 0:00–0:20 | Receivables overview and user problem | The user needs to know what is owed and what to do next. |
| 0:20–0:55 | Natural-language invoice request, draft, review and correction | AI reduces repetitive structuring while the user retains control. |
| 0:55–1:25 | Create/send through PayPal Sandbox and show returned reference | PayPal is a functional integration, not a decorative button. |
| 1:25–2:05 | Open overdue invoice, inspect evidence, edit reminder draft and approve | Recommendations are grounded and reviewed before action. |
| 2:05–2:35 | Execute supported Sandbox operation, refresh provider state, show activity | Proposed action, execution, and verified outcome are distinct. |
| 2:35–3:00 | Summarize value and sandbox boundary | CashPilot is a focused workflow copilot, not an autonomous financial decision-maker. |

## 13. Open product decisions

Resolve these explicitly before treating implementation as stable:

- Primary customer segment: default to a solo freelancer/owner-operator with a simple workspace model.
- AI provider and structured-output/tool-calling capability.
- Hosting and relational database provider.
- Authentication approach for the hackathon demo.
- PayPal account/API permissions, supported invoice operations, and reminder eligibility.
- Provider event/webhook availability and whether polling/refresh is the reliable MVP reconciliation method.
- Single configured currency and its precision rules.
- Exact normalized status mapping and treatment of unknown/unmapped provider states.

## 14. Relationship to other project documents

This concept document explains the **why and what**. `docs/requirements/SRS.md` captures the implementation and verification baseline. `docs/design/WIREFRAMES.md` captures the expected screen set and UI states. Where details differ, consult the original source documents and resolve the discrepancy deliberately.
