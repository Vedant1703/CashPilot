
---
name: review-financial-integrity
description: "Audits CashPilot invoice and collection changes for money errors, approval bypasses, incorrect status transitions, duplicate operations and audit gaps."
---

# Review Financial Integrity

1. Inspect the diff and trace affected workflows from UI to backend and database.
2. Check money arithmetic, currency handling and due-date boundaries.
3. Verify that server-side validation is authoritative.
4. Attempt to identify ways to send without approval.
5. Check whether editing a material field invalidates approval.
6. Verify that the approved payload matches the executed payload.
7. Inspect timeout handling, retries and duplicate-send prevention.
8. Verify that Paid requires provider confirmation.
9. Check unknown, unmapped and stale status behavior.
10. Verify that failed operations do not create false success states.
11. Check audit coverage and sensitive-data leakage.
12. Run relevant tests and report actual results.

Prioritize findings by severity. Include file references, the failure scenario and a concrete fix. Do not rewrite code unless asked to fix the findings.
