# CashPilot AI — UI Design Reference & Implementation Guide

> **Source Document:** [`docs/design/CashPilotAI_UIScreens.pdf`](file:///Users/vedantkulkarni/Documents/CashPilot/docs/design/CashPilotAI_UIScreens.pdf) (17 pages)  
> **Status:** Authoritative UI & UX design reference for all frontend implementation in CashPilot AI.

---

## 1. Brand Identity & Design Principles

### Core Principles
- **Calm:** Quiet surfaces, clean hierarchy, color used only where it carries specific semantic meaning.
- **Honest:** Every fact exposes its provenance (e.g., `Verified by PayPal`, `AI proposed`, `Your input`, `Sample data`). Never deceive or disguise uncertainty.
- **Human in Control:** AI proposes. You approve. PayPal verifies. Consequential operations require an explicit, un-bypassable human approval step.

### Brand Assets & Navi the Mascot
- **Logo:** Document, rising bars, growth arrow, and coin mark. Flat colour, single stroke weight, legible at 24px (favicon), 32px, 44px (header mark), and 48px.
- **Tagline:** *"Smarter receivables. Stronger business."*
- **Navi the Mascot & Chat Avatar:** Friendly robot character with a round visor, teal headset, and chest navigation arrow.
  - **States:**
    - **Idle:** Ready to help.
    - **Thinking:** Reading your invoices.
    - **Helping:** Proposing a next step / draft.
    - **Done:** Appears **only** after a PayPal-verified confirmation.
  - **Strict Placement Rules:**
    - Appears only in helper callouts, empty states, success states, and the AI Copilot drawer/panel.
    - **Never** placed next to money figures or on the approval sheet (financial decisions remain serious and un-gamified).

---

## 2. Design System Tokens & Styling Specifications

### Color Palette

| Token | Light Theme | Dark Theme | Purpose & Semantic Rule |
| :--- | :--- | :--- | :--- |
| **Ground (Page Background)** | `#F6F5F1` | `#0B1827` | Subtle warm off-white in light mode; deep navy in dark mode |
| **Surface (Cards & Panels)** | `#FFFFFF` | `#12263A` | Clean card background, distinct from ground |
| **Ink (Text & Navigation)** | `#12263F` | `#E8EEF5` | High-contrast body text, headings, and active nav items |
| **Teal (Verified / Primary)** | `#0C7C61` | `#34C79F` | Primary standard actions and **PayPal-verified** confirmations |
| **Violet (AI Proposed)** | `#5B3FD0` | `#B7A9FF` | Reserved **exclusively** for AI-proposed suggestions, drafts, and rankings |
| **Orange (Approval Required)** | `#B4440B` | `#FFA970` | Reserved **exclusively** for human approval gates and warning moments |
| **Gold (Due Soon / Stale)** | `#7A5600` | `#F2C65A` | Invoices due in 0–3 days or stale sync states |
| **Red (Overdue / Failed)** | `#B42318` | `#FF9189` | Overdue invoices, API errors, and rejected requests |

> [!IMPORTANT]
> **Status Accessibility Invariant:** Status must **never** rely on color alone. Every badge or status chip must combine a distinct symbol, color, and textual label (e.g., `● Verified by PayPal`, `▲ Needs review`, `✦ AI proposed`, `◷ Due soon`).

### Typography
- **Headlines & Expressive Moments:** `Newsreader` (Editorial serif) — gives authority and calm clarity to page titles and core questions (e.g., *"Who owes me money?"*, *"What are we billing?"*).
- **Interface, Tables, Body & Forms:** `Public Sans` (400 regular, 500 medium, 600 semibold) at 14–15px base size.
- **Technical Identifiers & Audit Records:** `IBM Plex Mono` — for invoice numbers (`INV-0014`), PayPal provider IDs (`INV2-3F8N-ZP6T-1VQ4`), and payload hashes (`a91f…3c2`).
- **Monetary Values:** Tabular figures (`font-variant-numeric: tabular-nums`) with explicit ISO currency code (e.g., `$4,800.00 USD`). Never floating-point rounding.

### Component Geometry & Interaction Standards
- **Buttons:** Border radius `12px` (`rounded-xl`).
- **Cards & Modal Sheets:** Border radius `16px` (`rounded-2xl`).
- **Touch / Click Targets:** Minimum `44px` height on all interactive controls for desktop and mobile accessibility.
- **Button Distinction:** Standard everyday buttons use Teal (`#0C7C61`). The critical "Approve and send" moment uses Orange (`#B4440B`), making consequential actions immediately distinguishable.

---

## 3. Screen Specifications & Workflow Architecture

### Screen 1: Dashboard / Overview (Page 4)
- **Header:** Workspace indicator (`Demo workspace · Sandbox · No real money moves`), PayPal sync badge with relative time (`Synced 4 min ago`), `Refresh` button, and `New invoice` CTA.
- **Navi Greeting Callout:** *"Two invoices need you today. Northwind Studio is 12 days overdue, and Brightleaf is due in 2 days. I've prepared next steps. Nothing is sent until you approve."*
- **Four Receivables Metric Cards:**
  1. **Outstanding:** Total sent but unpaid (e.g., `$4,800.00` · 3 sent invoices).
  2. **Overdue:** Invoices past due date (e.g., `$1,500.00` · 1 invoice, oldest 12 days late).
  3. **Due Soon (0–3 Days):** Invoices approaching deadline (e.g., `$900.00` · due Sun 18 Oct).
  4. **Paid This Month:** Confirmed payments (e.g., `$750.00` · confirmed by PayPal).
- **Dashboard Calculation Rule:** Totals count **only** unpaid invoices that PayPal has confirmed as sent. Drafts, cancelled, and unrecognised invoices are explicitly excluded.
- **Next Best Actions (AI Proposed):** Ranked list of actionable items with explicit justification tags and action buttons (e.g., `Review reminder`, `See why`, `Refresh`).
- **Outstanding by Stage Breakdown:** Mini progress bar and balance per stage.
- **Recent Activity Feed:** Latest 3 audit entries with verified badges.

### Screen 2: Collections Kanban Board (Page 5)
- **Columns:**
  1. `Draft` (Local or PayPal draft, not sent).
  2. `Awaiting payment` (Sent via PayPal, due date not reached).
  3. `Due soon` (0–3 days before due date).
  4. `Overdue` (Due date passed without PayPal confirmation of payment).
  5. `Paid` (Confirmed by PayPal).
- **Drag-and-Drop Invariant:**
  - Board cards move strictly by verified **PayPal status** and **due date**, **never by drag alone**.
  - Attempting to drag an invoice to `Paid` shows an informative popover:
    > *"▲ Can't move to Paid by dragging. PayPal reports payment, and CashPilot follows. Refresh to check."*
- **Outside the Board Tray:**
  - Dedicated bottom section for `Needs review` (unrecognised provider status) and `Cancelled` invoices.
  - **Invariant:** Invoices in this tray are never counted in dashboard totals and never hidden.

### Screen 3: Invoices Listing (Page 6)
- **Table Filters:** `All (7)`, `Draft (1)`, `Awaiting (1)`, `Due soon (1)`, `Overdue (1)`, `Paid (1)`, `Needs review (1)`.
- **Columns:** `Invoice`, `Client`, `Amount`, `Due`, `Status`, `Source`.
- **Provenance Badges:** Clear labels:
  - `Verified by PayPal` (Green)
  - `AI drafted · not yet in PayPal` (Violet)
  - `Sample data` (Muted/Grey - ensures mock/seed data is never confused with real Sandbox data)
  - `Needs review · Unrecognised PayPal status` (Gold/Orange)

### Screen 4: Invoice Detail (Page 7)
- **Header:** Breadcrumb (`Invoices / INV-0008`), client name, status chip, action buttons (`Refresh status`, `Draft reminder`).
- **Financial Details Grid:** Amount due, terms, issued date (`YOUR INPUT`), due date (`YOUR INPUT`), stage (`CALCULATED FROM DUE DATE`), PayPal status (`FROM PAYPAL`), recipient email, PayPal invoice ID (`IBM Plex Mono`).
- **Authoritative Line Items:** Item description, quantity × unit price, line totals, and server-calculated grand total (`"Totals are calculated by the app, never by AI"`).
- **Navi Suggestion Box:** Specific overdue explanation with `Draft the reminder` and `Dismiss` actions.
- **Invoice Audit History:** Chronological log for this specific invoice.

---

## 4. Invoice Studio Creation Journey (Pages 8–11)

A 4-step wizard with clear progress indicators:
`1 Describe` → `2 Review draft` → `3 Approve and send` → `4 PayPal confirms`

### Step 1: Describe (Page 8)
- **Prompt Input:** Natural language text area (*"What are we billing? Tell me in your own words. I'll turn it into an invoice you can edit."*).
- **Example Chips:** Quick prompts for quick testing (e.g., *"Bill Northwind $2,000 retainer, net 30"*).
- **Fallback Guarantee:** Link: *"Prefer a blank form? Draft with Navi"*. If the AI service cannot be reached, user input is preserved and a manual entry form opens.
- **AI Boundaries Callout:**
  - AI proposes client, line items, quantities, prices, dates.
  - Missing or unclear items are flagged, never guessed.
  - Application calculates every total.
  - Nothing is sent to PayPal until user approves.

### Step 2: Review Draft (Page 9)
- **Attention Banner:** *"Two things need your eyes. I couldn't find a recipient email for Acme Studio, and I worked out the due date (30 Oct) from '14 days'. I haven't guessed either one."*
- **Form Fields with Provenance:**
  - `Recipient email`: Flagged with `Needs your input` chip.
  - `Due date`: Flagged with `AI worked out` chip.
  - `Line items`: Description, quantity, unit price, server total.
- **Side-by-Side Synchronized Preview:** Live visual preview of the invoice document marked `Draft · This preview is built from the exact data that will go to PayPal`.
- **Action Buttons:** `Save draft` (secondary), `Create PayPal draft` (disabled until required fields are filled).

### Step 3: Approve and Send (Page 10)
- **Approval Sheet (Orange border/theme):**
  - Title: *"Needs your approval — This sends a real invoice through PayPal Sandbox."*
  - Material summary: Invoice ID, recipient, amount, currency, dates, line items, and PayPal draft ID.
  - **Payload Hash Binding:** Explicit message:
    > *"Your approval covers exactly this version. Recipient, amount, currency, dates and items are locked to hash **`a91f…3c2`**. If anything changes, the approval is cancelled and you review again."*
  - **Invalidation Notice:** If user goes back and edits any field:
    > *"Approval cancelled. The amount changed from $1,200.00 to $1,400.00. Review the new version and approve again."*
- **Actions:** `Back to edit` (secondary), `Approve and send via PayPal` (Orange primary button).

### Step 4: PayPal Confirms (Page 11)
- **Success State:** `Verified by PayPal` banner, provider status `SENT`, provider ID, confirmed timestamp, and CTAs (`See it on the board`, `Open invoice`, `Create another`).
- **Edge States Handled on this Screen:**
  - **Sending...:** Button locked, progress indicator active, double-send prevented.
  - **Not sent (PayPal Rejected):** Specific error explanation (e.g., invalid email format), draft preserved, `Fix the email` button.
  - **Unconfirmed (Timeout):**
    > *"No answer from PayPal yet. It may or may not have been sent. I won't call it sent until PayPal confirms, and retry stays locked until we know."*
    - Action: `Check with PayPal` (reconciliation request).

---

## 5. AI Copilot & Collections Automation (Pages 12–15)

### Ask Navi / Copilot (Page 12)
- **Grounding Rule:** Answers are strictly grounded in persisted invoices and PayPal status.
- **Safety Invariant:** Unsupported or unauthorized requests are explicitly refused:
  - *User:* *"Mark INV-0012 as paid and email everyone a discount"*
  - *Navi:* *"I can't do either of those. Payment status comes from PayPal, and I don't send messages or offer discounts on my own. I can draft a reminder for you to review."*
- **Explainable Ranking:** "Why Northwind is first" breaks down exact deterministic rules:
  - Days overdue: `12` (Calculated)
  - Amount: `$1,500.00` (Your invoice)
  - PayPal status: `SENT` (PayPal)
  - Earlier reminders: `None` (Activity)
  - Dispute: `No` (Notes)

### Reminder Drafting & Approval (Page 13)
- **Tone Selector:** `Friendly`, `Polite`, `Firm`.
- **Subject & Body Form:** AI-drafted message using invoice facts. No legal threats or unauthorized promises.
- **Pre-flight Safety Checklist:**
  - [x] Invoice is sent and unpaid (PayPal accepts reminders)
  - [x] No reminder sent recently
  - [x] No dispute or note flags client for review
  - [x] Status last confirmed by PayPal 4 min ago
- **Approval Gate:** Approval locks recipient, invoice, and exact message. `Approve and send reminder` executes through PayPal Sandbox.

### Status Refresh & Reconciliation (Page 14)
- **Refresh Flow:**
  `1 Ask PayPal` → `2 Check the answer` → `3 Match to a stage` → `4 Save and log` → `5 Update the board`
- **Reconciliation Table:** Lists each invoice, what PayPal reported, how it mapped to CashPilot stage, and the result.
- **Preservation of Stale State:** If PayPal is unreachable for an invoice, the last known status is retained with a `stale` warning. Never assumed Paid.
- **Board Change Summary:** Displays before-and-after counts per column and total outstanding.

### Activity & Audit History (Page 15)
- **Append-only Log:** Every proposal, human approval, provider call, and reconciliation attempt is logged with timestamp, actor (`You`, `Navi`, `System`, `PayPal`), and outcome.
- **Security & Privacy:** Secrets, tokens, and payment credentials are **never** logged.

---

## 6. Comprehensive Edge States Matrix (Page 16)

The application implements 9 explicit edge states:

| State # | Scenario | Visual Representation | User Action / Safety Guard |
| :--- | :--- | :--- | :--- |
| **1** | **Loading** | Quiet skeleton loader with text *"Opening your board. Loading invoices. Totals appear once every status is read."* | Prevents flash of incorrect `$0.00` balances. |
| **2** | **Empty Workspace** | Friendly illustration of Navi with *"No invoices yet."* | Buttons: `Describe an invoice` or `Load sample data`. |
| **3** | **PayPal Unreachable** | Amber banner: *"Couldn't reach PayPal. Showing last known statuses from [time]. Nothing here has been changed."* | Stale badges shown on affected cards. Invoices **never** marked Paid. Button: `Try again`. |
| **4** | **AI Unavailable** | Violet callout: *"✦ Navi is resting. Drafting and suggestions are paused. Everything else works."* | Buttons: `Create manually` (manual form fallback) and `Retry Navi`. |
| **5** | **PayPal Rejected Field** | Red warning with PayPal correlation reference: *"▲ PayPal didn't accept this draft. Recipient email looks invalid."* | Target field highlighted in red. Button: `Fix and re-review`. |
| **6** | **Couldn't Save** | Amber banner: *"▲ Your changes weren't saved. The invoice is unchanged. Your edits are kept on this screen."* | Edits retained in form state. Buttons: `Save again` and `Copy edits`. |
| **7** | **Unknown Status** | Status chip: `Needs review`. Placed outside the Kanban board. | Excluded from totals. Button: `Check again`. |
| **8** | **Send Timed Out** | Amber notice: *"● We don't know if it was sent. PayPal didn't answer in time. INV-0012 stays unconfirmed."* | Retry sending is disabled to avoid double billing. Button: `Check status with PayPal`. |
| **9** | **Action Completed** | Verified banner: *"Reminder sent. Confirmed by PayPal."* | Button: `See in Activity`. |

---

## 7. Responsive Mobile Adaptations (Page 17)

- **Mobile Viewport:** Fully functional down to `360px` viewport width.
- **Kanban Stack:** Horizontal scrollable stages or stacked tabs (`Overdue 2`, `Due 3`, `Sent 4`, `Paid`).
- **One-Thumb Interaction:** Primary action buttons fixed at bottom of screen with `44px` touch targets.
- **Approval Bottom Sheet:** Approval modal transitions to a native-feeling slide-up bottom sheet on mobile screens.
- **Bottom Navigation Bar:** 4 core tabs: `Home`, `Board`, `Invoices`, `Copilot`.

---

## 8. The 3-Minute Demo Sequence (Page 3)

| Step | Time | Screen | Key Narrative & Action |
| :---: | :---: | :--- | :--- |
| **1** | `0:00` | **Overview** | See money at a glance. Outstanding, overdue, and items needing attention. Highlight `Sample data` vs `Verified` badges. |
| **2** | `0:20` | **Invoice Studio (Describe)** | Type plain text prompt: *"Bill Acme Studio $1,200 for website design, net 14"*. Navi drafts draft in ~5 seconds. |
| **3** | `0:40` | **Review Draft** | Notice Navi flagged missing recipient email and calculated due date without guessing. User fills email. Server computes total. |
| **4** | `0:55` | **Approve & Send** | Inspect exact payload breakdown and version hash. Click `Approve and send via PayPal`. Show that approval is bound to hash. |
| **5** | `1:10` | **PayPal Confirms** | PayPal Sandbox returns 202 Accepted. Read status `SENT` back from PayPal. Show card appear on board. |
| **6** | `1:25` | **Collections Board** | Inspect overdue Northwind card. Attempt dragging to Paid — show error tooltip blocking bypass. |
| **7** | `1:40` | **Send Reminder** | Select tone (Friendly/Polite/Firm), review grounded reminder message, approve and send via PayPal. |
| **8** | `1:55` | **Ask Navi Copilot** | Ask *"Who should I chase first?"*. Observe deterministic rule-based ranking explanation. Ask to mark paid and see refusal. |
| **9** | `2:15` | **Refresh from PayPal** | Trigger manual refresh. Show 4-step reconciliation progress, before-and-after board metrics, and stale status preservation. |
| **10** | `2:35` | **Audit History** | Review end-to-end timeline of every AI draft, user approval, provider call, and status refresh. |
