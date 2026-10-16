# CashPilot AI 🚀

> **Intelligent, Human-in-the-Loop Receivables & Collections Workspace**  
> Built for freelancers and small service businesses to draft, manage, track, and collect invoices backed by verifiable PayPal Sandbox operations and evidence-grounded AI copilot recommendations.

---

## 📌 Executive Summary

Freelancers and small service businesses often struggle with fragmented receivables management—jumping between customer chats, spreadsheets, payment portals, and calendar reminders. 

**CashPilot AI** unifies the receivables workflow into a single, intuitive workspace:
1. **Natural Language Invoice Drafting:** Convert rough natural-language requests into structured, editable invoices with client validation.
2. **Deterministic Financial Correctness:** Totals, tax calculations, and state changes are computed strictly in deterministic application code using integer minor units or fixed-precision arithmetic (never floating point).
3. **Strict Human-in-the-Loop Approval:** AI proposes actions; the user explicitly reviews and approves the exact material payload before any external write is dispatched.
4. **PayPal Sandbox Operations:** Draft creation, invoice sending, and status verification are executed against the authentic PayPal Sandbox API.
5. **Separation of Workflow & Provider Status:** Raw PayPal status and normalized CashPilot workflow state are kept distinct. Only verified provider evidence can mark an invoice as **Paid**.
6. **Collections Kanban Board:** Visual lifecycle columns (Draft, Awaiting Payment, Due Soon, Overdue, Paid, Cancelled, Needs Review) with quick access to invoice details.
7. **Evidence-Grounded AI Copilot:** Context-aware copilot explains follow-up urgency citing specific persisted facts and drafts polite, editable reminder messages.
8. **Auditable Activity Log:** Append-only traceability from natural-language intent, through approval and provider calls, to status reconciliation.

---

## 🏛️ Invariants & Safety Principles

- **AI is an Advisor, Not an Operator:** The AI model never executes PayPal operations directly and cannot authorize itself.
- **Exact-Payload Binding:** Consequential actions bind approval to the exact material payload. Any edit to a material field invalidates the prior approval.
- **Truth from Provider Evidence:** A successful invoice send is *not* a payment. Only PayPal verification transitions an invoice to `Paid`.
- **Safe Recovery & Unknown States:** A timed-out external write represents an unknown outcome. The system reconciles before retrying to prevent duplicate operations.
- **Zero Secrets on Client:** All OAuth credentials, API keys, and external calls remain strictly on the server.

---

## 📁 Repository Structure

```text
.
├── .agents/                      # Agentic AI configuration & rules
│   ├── mcp_config.json           # Workspace MCP server configuration
│   ├── rules/                    # Behavioral & architectural rules
│   │   ├── ai-governance.md      # AI output validation & approval rules
│   │   ├── financial-integrity.md# Financial math & state transition rules
│   │   ├── frontend.md           # UI/UX & component standards
│   │   └── integrations.md       # PayPal & external API policies
│   └── skills/                   # Agent operational workflows
│       ├── implement-feature/    # SRS-driven feature delivery workflow
│       ├── paypal-sandbox-check/ # Sandbox configuration & integration check
│       └── review-financial-integrity/ # Integrity & approval audit workflow
├── docs/                         # Project specifications & documentation
│   ├── README.md                 # Documentation index & hierarchy
│   ├── product/                  # Problem statement, thesis & demo script
│   │   └── PRODUCT_CONCEPT.md
│   ├── requirements/             # System Requirements Specification (SRS)
│   │   └── SRS.md
│   └── design/                   # UI/UX wireframes & screen references
│       └── WIREFRAMES.md
├── AGENTS.md                     # Universal agent instructions & mission
├── .env.example                  # Environment configuration template
├── .gitignore                    # Version control exclusions
├── LICENSE                       # MIT License
└── README.md                     # Root project overview
```

---

## 📖 Documentation Index

- [Project Vision & Product Concept](docs/product/PRODUCT_CONCEPT.md)
- [Software Requirements Specification (SRS)](docs/requirements/SRS.md)
- [Wireframes & Screen Inventory](docs/design/WIREFRAMES.md)
- [Agent Invariants & Governance](AGENTS.md)

---

## ⚙️ Getting Started

### Prerequisites
- Node.js (v18+ recommended)
- npm or pnpm
- PayPal Developer Account with Sandbox credentials

### Environment Configuration
Copy the template and fill in your local sandbox credentials:
```bash
cp .env.example .env
```

---

## 📄 License
This project is licensed under the [MIT License](LICENSE).
