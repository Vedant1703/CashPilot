# CashPilot AI

> **AI-powered receivables management for freelancers and small businesses.**

[![Next.js](https://img.shields.io/badge/Next.js-black?style=for-the-badge&logo=next.js&logoColor=white)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white)](https://tailwindcss.com/)
[![Prisma](https://img.shields.io/badge/Prisma-2D3748?style=for-the-badge&logo=prisma&logoColor=white)](https://www.prisma.io/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-336791?style=for-the-badge&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![PayPal Sandbox](https://img.shields.io/badge/PayPal_Sandbox-003087?style=for-the-badge&logo=paypal&logoColor=white)](https://developer.paypal.com/)
[![Vitest](https://img.shields.io/badge/Vitest-6E9F18?style=for-the-badge&logo=vitest&logoColor=white)](https://vitest.dev/)
[![Playwright](https://img.shields.io/badge/Playwright-45ba4b?style=for-the-badge&logo=playwright&logoColor=white)](https://playwright.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=for-the-badge)](LICENSE)

*Built for the PayPal Hackathon.* CashPilot AI is an intelligent receivables copilot that bridges natural-language invoice creation, human approval workflows, and PayPal Sandbox settlement tracking into a unified, auditable workspace.

---

## About

CashPilot AI solves the fragmented, error-prone invoicing and follow-up routine that burdens freelancers and boutique agencies. Instead of juggling loose emails, manual spreadsheet updates, and awkward collection messages, CashPilot provides an integrated operations cockpit where AI drafts invoices from plain text and prioritizes collections, while financial totals and transmissions remain strictly validated and human-approved.

> **Core Philosophy:** AI proposes. User approves. PayPal verifies.

---

## The Problem

| Traditional Receivables | CashPilot AI |
| :--- | :--- |
| **Scattered Tools:** Invoices, chats, and spreadsheets disconnected | **Unified Cockpit:** Invoicing, collections, and client records in one workspace |
| **Manual Data Entry:** Slow, repetitive math prone to calculation errors | **Natural-Language Drafting:** Plain-text prompts converted to structured drafts |
| **Blind Follow-ups:** Awkward reminder emails and overlooked due dates | **Ask Navi Copilot:** AI-ranked overdue prioritization and pre-filled reminders |
| **Uncertain Cash Flow:** Sent invoices mistaken for collected revenue | **PayPal-Verified Truth:** Status transitions to `PAID` only via provider sync |

---

## How It Works

> `1. Describe` $\rightarrow$ `2. Review & Approve` $\rightarrow$ `3. PayPal Dispatch` $\rightarrow$ `4. Sync & Collect`

| Stage | User Action | System Execution |
| :--- | :--- | :--- |
| **1. Draft** | Enter a natural-language billing prompt | AI interprets intent and proposes structured line items, rates, and due dates |
| **2. Review & Approve** | Inspect draft, quick-add client, and approve | Validates minor-unit math & binds approval to an exact SHA-256 material hash |
| **3. Dispatch** | Confirm approved operation | Creates draft and dispatches invoice to recipient via PayPal Sandbox v2 APIs |
| **4. Reconcile** | Trigger status sync & view Collections board | Pulls live provider state on demand to reconcile Kanban & guide next actions |

*Consequential external operations always require explicit human confirmation.*

---

## Key Features

| Module | Core Capability |
| :--- | :--- |
| **Invoice Studio** | Plain-English prompt drafting (Gemini 1.5 Pro + deterministic fallback), live preview, and inline client quick-add. |
| **Human Approval Gate** | Cryptographic SHA-256 material payload hash validation before every external PayPal operation. |
| **Collections Kanban** | 7-stage visual lifecycle board (`DRAFT` $\rightarrow$ `AWAITING_PAYMENT` $\rightarrow$ `PAID`, etc.) with instant filters and detail drawers. |
| **Ask Navi AI Copilot** | Fact-grounded receivables assistant ranking overdue accounts and suggesting collection follow-ups without hallucinations. |
| **Client Directory** | Workspace-scoped client profiles with search and referential integrity protection against deleting billed clients. |
| **Activity History** | Immutable append-only audit trail logging approvals, transmissions, reminders, cancellations, and reconciliations. |
| **Authentication & Workspaces** | Scrypt password hashing, secure session cookies, multi-tenant workspace isolation, and one-click demo login. |
| **PayPal Sandbox** | Full invoice lifecycle: draft creation, email dispatch, formal reminders, cancellation, and pull-based sync. |

---

## AI and PayPal Integration

| Component | Responsibility | What It Does | Strict Boundary |
| :--- | :--- | :--- | :--- |
| **AI Layer** | Proposal & Guidance | Converts plain text to draft items; ranks overdue receivables | Proposes only; cannot modify financial totals or execute actions |
| **CashPilot Server** | Authority & Guardrails | Minor-unit integer math, SHA-256 approval hashes, audit logging | Enforces workspace isolation; validates all payloads server-side |
| **PayPal Sandbox** | Settlement Truth | Creates drafts, dispatches emails, delivers reminders, confirms payments | Pull-based sync (`/api/invoices/:id/sync`); only provider proof sets `PAID` |

> **Core Principle:** AI proposes. User approves. PayPal verifies.

---

## Tech Stack

| Layer | Technologies | Purpose |
| :--- | :--- | :--- |
| **Frontend** | Next.js (App Router), React, Tailwind CSS | Responsive dashboard, Server Components, and accessible UI modals. |
| **Backend & APIs** | Next.js Route Handlers, TypeScript, Zod | Type-safe REST APIs, strict schema validation, and server-side money math. |
| **Database & ORM** | PostgreSQL, Prisma ORM | Relational persistence, migrations, and tenant-isolated workspace models. |
| **External Providers** | PayPal Sandbox (v2 Invoicing), Google Gemini | Provider operations and structured AI extraction with rule-based fallback. |
| **Testing** | Vitest, Playwright | Unit, integration, and browser end-to-end tests with test database isolation guards. |

---

## Getting Started

### Prerequisites

- **Node.js:** `v20.x` or later
- **Docker & Docker Compose:** For running PostgreSQL locally
- **npm:** Package manager (bundled with Node.js)

### Quick Setup

```bash
# 1. Clone the repository
git clone https://github.com/Vedant1703/CashPilot.git
cd CashPilot

# 2. Install dependencies
npm install

# 3. Configure environment variables
cp .env.example .env.local

# 4. Start local PostgreSQL database via Docker Compose
docker compose up -d

# 5. Generate Prisma Client and apply migrations
npm run db:generate
npm run db:migrate

# 6. Seed demo workspace and sample invoices
npm run db:seed

# 7. Start the development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser. For instant judge evaluation, visit `/login` and select **"Evaluate Judge Demo"** to access the pre-configured demo workspace.

---

## Environment Variables

Configure essential variables in `.env.local` (server-side only; never exposed to browser bundles):

| Variable | Required | Default / Safe Example | Description |
| :--- | :---: | :--- | :--- |
| `DATABASE_URL` | **Yes** | `postgresql://cashpilot:your_secure_password@127.0.0.1:5433/cashpilot_dev?schema=public` | PostgreSQL connection URL (host port 5433). |
| `SESSION_SECRET` | **Yes** | `(64-character hex string)` | Key for session token hashing (`openssl rand -hex 32`). |
| `PAYPAL_ENV` | **Yes** | `sandbox` | PayPal mode; restricted strictly to Sandbox. |
| `PAYPAL_CLIENT_ID` | Optional | `your_paypal_sandbox_client_id` | PayPal Sandbox REST App Client ID. |
| `PAYPAL_CLIENT_SECRET` | Optional | `your_paypal_sandbox_client_secret` | PayPal Sandbox REST App Secret. |
| `PAYPAL_BASE_URL` | Optional | `https://api-m.sandbox.paypal.com` | PayPal Sandbox API base endpoint. |
| `AI_PROVIDER` | Optional | `google` | AI engine provider (`google`, `anthropic`, `openai`). |
| `AI_API_KEY` | Optional | `your_gemini_api_key` | API key for Gemini inference (falls back to rules if unset). |
| `AI_MODEL` | Optional | `gemini-1.5-pro` | Model version for extraction and copilot. |
| `TEST_DATABASE_URL` | Optional | `postgresql://cashpilot:...@127.0.0.1:5433/cashpilot_disposable_test` | Dedicated database for automated test runs. |

---

## Testing

CashPilot includes comprehensive automated tests covering API endpoints, financial arithmetic, and UI workflows.

> **Safety Notice:** Automated tests strictly require a dedicated disposable test database named `cashpilot_disposable_test`. Test runners automatically reject runs against development databases.

```bash
# Run unit and integration tests (Vitest)
npm test

# Run TypeScript type check
npm run typecheck

# Run ESLint code quality inspection
npm run lint

# Validate OpenAPI 3.1.0 contract integrity
npm run openapi:validate

# Run end-to-end browser journeys (Playwright)
npm run test:e2e
```

---

## API Documentation

CashPilot provides a synchronized OpenAPI 3.1.0 specification documenting 18 paths across 21 endpoint operations:

- **Interactive Swagger UI:** Visit [`/api-docs`](http://localhost:3000/api-docs) in your browser.
- **OpenAPI 3.1.0 JSON Spec:** Available at [`/api/openapi.json`](http://localhost:3000/api/openapi.json).
- **Contract Validation:** Run `npm run openapi:validate` to verify route alignment.

---

## License

This project is licensed under the [MIT License](LICENSE).
