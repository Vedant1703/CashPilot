---
trigger: glob
globs: src/**/*.tsx, src/**/*.css
---


---
trigger: glob
globs: "src/**/*.tsx, src/**/*.css"
description: "CashPilot frontend component reuse, responsive layouts, accessibility, design consistency and UI state handling."
---

# Frontend Rules

- Follow the approved CashPilot wireframes and existing design system.
- Reuse existing components before introducing new UI dependencies.
- Keep business logic out of presentation-only components.
- Use typed props and handle missing or optional data explicitly.
- Provide visible loading, empty, success, stale and error states.
- Clearly distinguish fixture data, AI proposals and PayPal-verified records.
- Show the source of important financial values where required.
- Never display a successful operation before the backend confirms it.
- Preserve visible approval details, including recipient, amount, currency and dates.
- Make core workflows usable at 360 CSS pixels and on desktop.
- Use semantic HTML, accessible labels, keyboard navigation and visible focus.
- Do not allow client-side state to override server-authoritative financial status.
- Avoid unnecessary dependencies, decorative complexity and unrelated refactors.
  