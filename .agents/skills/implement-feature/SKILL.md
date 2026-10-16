
---
name: implement-feature
description: "Implements a CashPilot feature from the SRS through planning, coding, tests, verification and a concise completion report."
---

# Implement Feature

## Procedure

1. Read AGENTS.md and relevant rules.
2. Locate the relevant SRS requirements and acceptance tests.
3. Inspect the current implementation before editing.
4. Identify dependencies, affected modules and API contracts.
5. State a concise implementation plan and unresolved questions.
6. Implement the smallest complete feature.
7. Validate inputs and authorization on the server.
8. Add or update unit, integration or end-to-end tests as appropriate.
9. Run relevant tests, linting and type checks.
10. Inspect the final diff for unrelated changes and security issues.
11. Update documentation if architecture or behavior changed.

## CashPilot-specific checks

- Financial calculations are deterministic.
- Provider status is not inferred from AI output.
- Consequential actions require valid user approval.
- External write failures and unknown outcomes are recoverable.
- Audit events are recorded where required.
- UI states distinguish mock, AI-proposed and provider-verified data.

## Final report

Report:
- Requirements implemented.
- Files changed.
- Tests and commands actually executed.
- Pass/fail results.
- Known limitations and remaining work.

Never claim success without verification.
