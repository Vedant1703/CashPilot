# CashPilot AI — Project Documentation

This folder contains agent-friendly Markdown references for the CashPilot AI hackathon project.

## Source of truth and document hierarchy

1. **`product/PRODUCT_CONCEPT.md`** explains the problem, intended users, product thesis, differentiation, MVP boundaries, and demo story.
2. **`requirements/SRS.md`** is the condensed implementation baseline: functional requirements, data/status rules, safety constraints, acceptance scenarios, risks, and open decisions.
3. **`design/WIREFRAMES.md`** describes the screens and interaction states the implementation should cover.

The original PDFs/DOCX used to prepare these files should remain available in the project or team drive. This Markdown set is an agent-friendly working reference, not a claim that every paragraph, table, illustration, or requirement in the original 24-page SRS and 16-page product concept has been reproduced verbatim. When a detailed requirement or ambiguity matters, consult the original source document and update this documentation deliberately.

## Core product invariant

AI may interpret, draft, explain, and recommend. The application validates data and enforces permissions. A user explicitly approves consequential actions. PayPal responses—not AI output or local UI state—determine provider-side invoice/payment status.

## Suggested repository layout

```text
.
├── AGENTS.md
├── .agents/
│   ├── mcp_config.json
│   ├── rules/
│   └── skills/
└── docs/
    ├── README.md
    ├── product/
    │   └── PRODUCT_CONCEPT.md
    ├── requirements/
    │   └── SRS.md
    └── design/
        └── WIREFRAMES.md
```

## How the agent should use these documents

- Read `AGENTS.md` first for project-wide invariants.
- Read the relevant document before implementing a feature.
- Treat explicit SRS requirements and acceptance criteria as the baseline.
- If a requirement conflicts with a security/financial-integrity rule, stop and surface the conflict instead of silently choosing.
- Track unresolved product/provider questions as open decisions.
- Do not claim that a PayPal Sandbox operation works until a real Sandbox result has been observed.
