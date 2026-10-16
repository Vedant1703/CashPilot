---
trigger: always_on
---


---
trigger: always_on
description: "CashPilot financial correctness, invoice states, exact-payload approvals, money arithmetic, retries and audit requirements."
---

# Financial Integrity Rules

- Never use JavaScript floating-point arithmetic for monetary calculations.
- Use integer minor units or fixed-precision decimals and always retain currency.
- Calculate authoritative invoice totals on the server.
- Validate all invoice fields before persistence or provider calls.
- Keep PayPal's raw invoice status separate from CashPilot's normalized workflow state.
- Only verified provider evidence may establish a Paid state.
- A successful send operation does not mean the invoice has been paid.
- Never convert unknown or stale provider state into Paid.
- Never assume a timed-out external write failed.
- Reconcile uncertain operations before retrying them.
- Bind every consequential approval to the exact material action payload.
- Any material payload change invalidates the previous approval.
- Revalidate approval and authorization immediately before execution.
- Record approval, execution attempts, results and reconciliation in the audit trail.
- Never permit drag-and-drop to bypass financial state rules.
  