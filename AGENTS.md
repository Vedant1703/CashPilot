
# CashPilot AI — Agent Instructions

## 1. Project mission

Build CashPilot AI, a responsive receivables and collections workspace
for freelancers and small service businesses.

The core journey is:
natural-language invoice draft -> validation -> user approval ->
PayPal Sandbox operation -> provider status verification ->
collections board update -> activity audit.

The SRS and approved project decisions are the implementation baseline.

## 2. Source of truth

Before implementing a feature:
- Read the relevant SRS requirements and acceptance criteria.
- Check docs/architecture.md and docs/decisions.md.
- Inspect existing code and reuse established patterns.
- Do not invent requirements or silently change the product scope.
- Document unresolved decisions instead of guessing.

## 3. Product and safety invariants

- AI may interpret, structure, summarize, explain and propose.
- AI must never directly execute PayPal operations.
- Every consequential external action requires explicit user approval.
- The server independently validates the approved action.
- Editing a material field after approval invalidates that approval.
- Never mark an invoice Paid based only on AI output, a local action,
  a successful send request, or a drag-and-drop event.
- Provider status and CashPilot workflow status must remain separate.
- Unknown or stale status must never be silently treated as Paid.
- A timeout is an unknown outcome until reconciled.
- Never blindly retry a potentially successful external write.

## 4. Financial correctness

- Never use JavaScript floating-point arithmetic for money calculations.
- Use integer minor units or an appropriate fixed-precision decimal type.
- Always retain the currency alongside monetary values.
- Calculate invoice totals on the server.
- Validate quantities, unit prices, dates, currencies and required fields.
- Use one documented timezone and due-date policy.
- Dashboard totals must use documented, deterministic business rules.

## 5. Architecture

- Use TypeScript and strict type checking.
- Follow the existing modular-monolith architecture.
- Keep UI components separate from business logic and provider clients.
- Put PayPal credentials and external API calls on the server only.
- Use typed schemas at all external input boundaries.
- Keep AI provider integration behind a small adapter.
- Use database migrations for schema changes.
- Do not add microservices or infrastructure without a demonstrated need.

## 6. AI implementation

- Use structured output validated against a schema.
- Treat prompts, model output and retrieved text as untrusted input.
- Retrieve relevant persisted facts before generating recommendations.
- Include evidence and reasons for every recommendation.
- Ask for clarification when material facts are missing or ambiguous.
- Never let the model calculate authoritative invoice totals.
- Never expose secrets or unrelated client records to the model.
- Provide a manual invoice form when AI is unavailable.
- Use allowlisted application functions, not unrestricted tools.

## 7. PayPal integration

- Use PayPal Sandbox exclusively.
- Keep OAuth credentials and tokens server-side.
- Validate current API schemas, account permissions and capabilities.
- Persist provider IDs and safe operation references.
- Separate draft creation, sending and status retrieval.
- Handle timeouts, rate limits, validation errors and unknown outcomes.
- Reconcile before retrying uncertain external writes.
- Never label mock data as PayPal-verified.

## 8. Approval and audit

- Bind approvals to the exact material action payload.
- Revalidate authorization, approval and payload integrity server-side.
- Reject expired, changed or reused approvals where applicable.
- Make external write operations idempotent or safely reconcilable.
- Record approval, execution attempt, result and synchronization events.
- Keep audit history append-only through application behavior.
- Never log access tokens, secrets or unnecessary personal data.

## 9. Code quality

- Prefer small, focused modules and explicit types.
- Avoid duplicated business rules.
- Avoid unnecessary abstractions and dependencies.
- Handle loading, empty, stale, success and error states explicitly.
- Maintain keyboard accessibility and responsive layouts.
- Keep the implementation aligned with the existing design system.
- Do not silently swallow exceptions or display fake success states.

## 10. Required workflow for every task

1. Inspect relevant files and requirements.
2. State the proposed approach and affected modules.
3. Implement the smallest complete change.
4. Run formatting, linting, type checks and relevant tests.
5. Inspect the diff for unrelated changes and security issues.
6. Report files changed, commands run, test results and known gaps.

Do not claim a test passed unless it was actually executed.
Do not claim a provider operation succeeded without provider evidence.
Do not change unrelated code merely to satisfy a task.

## 11. Definition of done

A feature is complete only when:
- The intended behavior is implemented.
- Input and authorization checks exist on the server.
- Relevant tests pass.
- Dependency failure and recovery are handled where applicable.
- The UI exposes the correct source and state of information.
- Relevant documentation is updated.



## Project Documentation

- Read `docs/README.md` for the documentation index.
- Consult `docs/product/PRODUCT_CONCEPT.md` for the problem, product vision, MVP scope, and demo narrative.
- Consult `docs/requirements/SRS.md` before implementing or modifying requirements-driven behavior.
- Consult `docs/design/WIREFRAMES.md` and the original wireframes before changing the UI.
- Treat the SRS and its acceptance criteria as the implementation baseline.
- If requirements are ambiguous or conflict, explain the conflict before making a consequential assumption.
- Update relevant documentation when an approved product decision or implementation behavior changes.
