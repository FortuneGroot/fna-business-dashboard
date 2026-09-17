# Client Onboarding Checklist ($297 Unlimited)

**HIGHLEVEL PLAN:** `$297 Unlimited`

**NOT DEPENDENT ON:**
- $497 Agency Pro
- Advanced OAuth
- agency-level CRM API
- white-label native mobile app add-on

Architecture for every client:
`GHL workflows → signed outbound webhooks → Supabase sync → F&A branded dashboard`

Protected Master (never use as a client location):  
`NQwD3zdWCuBSVpOuzybj` — *F&A MASTER CORE - DO NOT USE LIVE - v1.0*

Use with:
- `config/client-remap.template.json`
- `scripts/check-client-readiness.ts`
- `GET /api/onboarding/readiness`
- `docs/CLIENT_GO_LIVE_GATE.md`

---

## A. CLIENT INFO COLLECTION

| | |
|---|---|
| **OWNER ACTION** | Collect business name, legal name, industry, address/ZIP, timezone, phone, support email, lead notification email, website, logo, branding colors, booking/review preferences. |
| **AUTOMATABLE** | Partial — store into `ClientConfig` JSON once collected. |
| **VERIFY** | All identity fields non-empty; emails valid; no Master IDs. |
| **BLOCKER IF MISSING** | Cannot remap Custom Values or brand the dashboard. |

## B. CREATE / CLONE GHL SUB-ACCOUNT

| | |
|---|---|
| **OWNER ACTION** | Create or Snapshot-clone a **sub-account** on the $297 plan. Never clone into / from the protected Master as the live client. |
| **AUTOMATABLE** | No (HighLevel UI / Snapshot). |
| **VERIFY** | New `locationId` ≠ Master; account name matches client. |
| **BLOCKER IF MISSING** | No place to run workflows or calendars. |

## C. REPLACE CLIENT CUSTOM VALUES

| | |
|---|---|
| **OWNER ACTION** | Replace FNA \| Support Email, Lead Notification Email, Logo URL, Booking URL, Reschedule URL, Review URL, ZIP (and any client CVs) using the remap manifest. |
| **AUTOMATABLE** | Partial — checklist + config file; apply in GHL UI. |
| **VERIFY** | Values match `ClientConfig`; no `REPLACE_ME` leftovers. |
| **BLOCKER IF MISSING** | Workflows send wrong contact info. |

## D. PIPELINE CHECK

| | |
|---|---|
| **OWNER ACTION** | Confirm Sales Pipeline exists; record `pipelineId` + stage IDs by **name** in remap manifest. |
| **AUTOMATABLE** | Partial — IDs recorded in config after owner reads them. |
| **VERIFY** | Pipeline present; stages match canonical names; not Master/old pipeline. |
| **BLOCKER IF MISSING** | Opportunity sync and sales board broken. |

## E. CALENDAR CHECK

| | |
|---|---|
| **OWNER ACTION** | Confirm booking calendar(s); set primary `bookingCalendarId`, booking + reschedule URLs. |
| **AUTOMATABLE** | Partial. |
| **VERIFY** | Calendar bookable; URLs https; `channels.calendarEnabled=true`. |
| **BLOCKER IF MISSING** | Appointment workflows and dashboard calendar empty. |

## F. PHONE / SMS / A2P

| | |
|---|---|
| **OWNER ACTION** | Assign number; complete A2P / brand registration as required for the client's SMS use. Keep SMS off until approved. |
| **AUTOMATABLE** | No. |
| **VERIFY** | Phone on config; `smsEnabled` only after A2P; no live sends during test. |
| **BLOCKER IF MISSING** | SMS sequences cannot go live (email-only may still proceed if approved). |

## G. EMAIL CONFIG

| | |
|---|---|
| **OWNER ACTION** | Configure sending domain / mailbox for the sub-account; set support + lead notification emails. |
| **AUTOMATABLE** | Partial. |
| **VERIFY** | Emails deliver in test mode; not `@example.com` placeholders for go-live. |
| **BLOCKER IF MISSING** | Acknowledgment / nurture email paths fail. |

## H. REVIEW LINK

| | |
|---|---|
| **OWNER ACTION** | Provide Google (or approved) review URL; set Review Custom Value + config `reviewUrl`. |
| **AUTOMATABLE** | Partial. |
| **VERIFY** | HTTPS review URL opens; review workflow can reference it. |
| **BLOCKER IF MISSING** | Review request path blocked. |

## I. WEBSITE / FORM CONNECTION

| | |
|---|---|
| **OWNER ACTION** | Point forms/chat to this sub-account; confirm form IDs or embed targets. Do not modify public marketing site from this repo unless separately tasked. |
| **AUTOMATABLE** | Partial. |
| **VERIFY** | Test form creates contact in **client** location only. |
| **BLOCKER IF MISSING** | Lead capture adapters cannot feed intake. |

## J. DASHBOARD SYNC WEBHOOKS

| | |
|---|---|
| **OWNER ACTION** | Set `GHL_WEBHOOK_SECRET` on Vercel Preview for the client app; configure workflow Custom Webhooks to the dashboard `/api/webhooks/ghl` with signed header; set Supabase env if durable sync required. |
| **AUTOMATABLE** | Partial — Grok adds webhook actions per sync map; owner sets secrets. |
| **VERIFY** | `/api/sync/health` shows events; readiness `webhookSecretConfigured=true`; Master rejected. |
| **BLOCKER IF MISSING** | Dashboard stays “Waiting for HighLevel sync”. |

## K. CLIENT USERS / STAFF

| | |
|---|---|
| **OWNER ACTION** | Invite staff; map `assignedUserIds` for routing / AI escalation. |
| **AUTOMATABLE** | Partial. |
| **VERIFY** | At least one real user ID in config; calendars hosted. |
| **BLOCKER IF MISSING** | Assignment and handoff incomplete. |

## L. AI SETTINGS

| | |
|---|---|
| **OWNER ACTION** | Set AI business name, greeting, escalation target; leave Conversation/Voice AI off until approved. |
| **AUTOMATABLE** | Partial. |
| **VERIFY** | AI flags match client policy; no HighLevel brand leakage in copy. |
| **BLOCKER IF MISSING** | Non-blocking if AI disabled; blocking if AI enabled without context. |

## M. PAYMENT SETTINGS

| | |
|---|---|
| **OWNER ACTION** | Connect Stripe (or approved processor) only if client buys payments; else leave disabled. |
| **AUTOMATABLE** | No. |
| **VERIFY** | `paymentsEnabled` matches reality; no fake “paid” states. |
| **BLOCKER IF MISSING** | Non-blocking if payments not sold. |

## N. TEST CONTACT

| | |
|---|---|
| **OWNER ACTION** | Create **fake** contact only (`@example.invalid` / approved fake phone) with `FAKE_CONTACT_ONLY=true` and dry-run protections. |
| **AUTOMATABLE** | Partial — payload fixtures. |
| **VERIFY** | Contact in client location; never Master; no real customer. |
| **BLOCKER IF MISSING** | Cannot prove E2E. |

## O. E2E QA

| | |
|---|---|
| **OWNER ACTION** | Run `docs/FIRST_FAKE_CLIENT_E2E.md` and `docs/CLIENT_GO_LIVE_GATE.md`. |
| **AUTOMATABLE** | Partial — readiness script + sync health. |
| **VERIFY** | Lead → pipeline → appointment → dashboard sync → duplicate protection. |
| **BLOCKER IF MISSING** | No GO-LIVE. |

## P. GO-LIVE

| | |
|---|---|
| **OWNER ACTION** | Flip only after gate PASS; enable channels deliberately; keep Production domain/secrets owner-controlled. |
| **AUTOMATABLE** | No. |
| **VERIFY** | Readiness `READY`; gate checklist complete. |
| **BLOCKER IF MISSING** | Remain in Preview / Draft. |

## Q. POST-LAUNCH CHECK

| | |
|---|---|
| **OWNER ACTION** | Watch first real lead (with consent); confirm alerts, sync counts, no Master leakage, no unintended sends. |
| **AUTOMATABLE** | Partial — `/api/sync/health` monitoring. |
| **VERIFY** | 24–72h hygiene: errors, duplicates, A2P, reviews. |
| **BLOCKER IF MISSING** | Pause automations if critical failures. |
