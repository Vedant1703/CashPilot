
---
name: paypal-sandbox-check
description: "Verifies CashPilot's PayPal Sandbox configuration, invoice API integration, provider status reconciliation and safe error handling."
---

# PayPal Sandbox Check

1. Inspect the existing PayPal adapter and integration tests.
2. Verify required environment variable names without printing secret values.
3. Confirm that the configured environment is Sandbox.
4. Check current official API documentation and request/response schemas.
5. Verify OAuth token handling remains server-side.
6. Test draft invoice creation and persistence of the provider ID.
7. Test sending only after valid server-side approval.
8. Retrieve provider state and verify normalized board placement.
9. Exercise provider rejection, timeout and unknown-outcome handling.
10. Verify reconciliation before retrying an uncertain write.
11. Check that safe activity events record operation outcomes.
12. Report which checks were actually executed.

Use mocks for deterministic failure tests and a configured Sandbox account for genuine integration tests. Never claim a live provider call succeeded unless its result was observed.
