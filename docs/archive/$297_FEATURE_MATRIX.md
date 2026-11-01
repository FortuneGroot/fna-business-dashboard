# $297 Feature Matrix

**HIGHLEVEL PLAN:** `$297 Unlimited`

**NOT INCLUDED / NOT DEPENDENT ON:**
- $497 Agency Pro
- Advanced OAuth
- agency-level CRM API
- white-label native mobile app add-on

Anything that would require those is marked **NOT INCLUDED**.

| FEATURE | AVAILABLE ON $297 | CLIENT CONFIG REQUIRED | GHL NATIVE | F&A DASHBOARD | AUTOMATED | MANUAL | BLOCKER |
|---|---|---|---|---|---|---|---|
| Sub-account Snapshot clone | YES | locationId | YES | NO | NO | YES | Wrong location / Master |
| Custom Values remap | YES | emails, URLs, ZIP, name | YES | NO | PARTIAL | YES | Leftover donor values |
| Sales pipeline + stages | YES | pipelineId, stageIds | YES | YES (synced) | PARTIAL | YES | Missing pipeline |
| Calendars / booking links | YES | calendarIds, booking/reschedule URLs | YES | YES (synced) | PARTIAL | YES | Missing calendar |
| Forms / lead capture | YES | form targets (ops) | YES | YES via webhook | PARTIAL | YES | Forms not pointed at client |
| Workflow automations | YES | — | YES | via webhooks | NO (Grok/owner) | YES | Draft/publish QA |
| Signed outbound webhooks → sync | YES | webhookDestination + secret flag | YES (Custom Webhook) | YES | YES (ingest) | YES (wire/secret) | Secret / destination missing |
| Durable sync store (Supabase) | YES | SUPABASE_* env | NO | YES | YES | YES (project) | Multi-instance without DB |
| Branded dashboard UI | YES | branding + logo | NO | YES | PARTIAL | YES | Incomplete branding |
| Contacts / pipeline / calendar views | YES | sync events | NO* | YES | YES (from webhooks) | NO | Empty until webhooks fire |
| Inbox conversation summaries | YES | conversation events | NO* | YES | YES | YES (workflow emit) | No message-history CRM API |
| Agency PIT location health | YES | GHL_API_TOKEN (optional) | YES (limited) | `/api/ghl/health` | YES | YES | Invalid token |
| Direct CRM list reads (contacts/opps/cals) | LIMITED / NOT RELIED ON | — | Scope-limited on $297 | NOT REQUIRED | NO | — | Do not design around Advanced API |
| Advanced OAuth marketplace app | NOT INCLUDED | — | $497-oriented | NO | NO | — | Plan upgrade |
| Agency Pro CRM API expansion | NOT INCLUDED | — | $497 | NO | NO | — | Plan upgrade |
| White-label native mobile app add-on | NOT INCLUDED | — | Add-on | NO | NO | — | Not sold in this product |
| SMS / A2P messaging | YES (after A2P) | phone, smsEnabled | YES | alerts via sync | NO | YES | A2P incomplete |
| Email sequences | YES | support/lead emails, mailbox | YES | sync events | NO | YES | Mailbox not configured |
| Review request path | YES | reviewUrl | YES | review events | PARTIAL | YES | Missing review URL |
| Conversation AI | OPTIONAL | ai flags + greeting | YES | status only | NO | YES | Unapproved AI copy |
| Voice AI | OPTIONAL | ai flags | YES | status only | NO | YES | Unapproved voice |
| Payments / Stripe | OPTIONAL | payments flags | YES/Stripe | shell | NO | YES | Processor not connected |
| Custom domain (app.*) | OPTIONAL | domain | DNS/Vercel | YES | NO | YES | Premature Production attach |
| Production CRM writes from dashboard | NO (default) | safety flags | — | blocked by design | YES (guards) | — | Writes enabled by mistake |
| Client readiness / go-live gate | YES | full ClientConfig | NO | `/api/onboarding/readiness` | YES | YES | PLACEHOLDER / Master / missing maps |

\*Dashboard data comes from **workflow webhooks**, not live CRM list APIs.

---

## Related

- `docs/CLIENT_ONBOARDING_CHECKLIST.md`
- `docs/CLIENT_CLONE_MANIFEST.md`
- `docs/FAST_CLIENT_ONBOARDING.md`
- `docs/GHL_SYNC_WEBHOOK_CONTRACT.md`
