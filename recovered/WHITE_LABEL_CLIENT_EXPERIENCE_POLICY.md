# WHITE-LABEL CLIENT EXPERIENCE POLICY

**Audience:** INTERNAL — F&A ONLY (operators, developers, trainers)  
**Applies to:** All client-facing materials, login instructions, training, onboarding, support, sales explanations, and PDFs given to Fortune & Automations clients.

---

Fortune & Automations sells and supports the Fortune & Automations Business Dashboard. HighLevel is underlying infrastructure and is not presented as the client-facing product. Internal technical documentation may identify HighLevel where necessary for implementation and maintenance. Client-facing materials, login instructions, training, onboarding and support documentation must use Fortune & Automations branding and approved terminology.

---

## Product names

| Layer | Name |
|---|---|
| Client-facing product | Fortune & Automations Business Dashboard (also: F&A Business Dashboard, Business Dashboard, F&A system, your business dashboard, your private dashboard, your customer system, your F&A account) |
| Underlying platform (internal only) | HighLevel / GoHighLevel |

## Client-facing forbidden terms

Do not use these with clients, in client PDFs, client training, client onboarding email, or customer-facing system-access copy:

- HighLevel, GoHighLevel, GHL
- LeadConnector, Lead Connector
- app.gohighlevel.com, gohighlevel.com, leadconnectorhq.com
- “HighLevel sub-account”, “GHL account”, “GHL app”

## Login (required)

Instruct clients:

> Go to **app.fortuneandautomations.com** and sign in to your Fortune & Automations Business Dashboard.

Never instruct a client to visit app.gohighlevel.com, search for HighLevel, or create a HighLevel account.

## Branded domains (planned agency defaults)

| Use | Domain |
|---|---|
| Desktop/web login | `app.fortuneandautomations.com` |
| System-generated links (forms, surveys, calendars, trigger links, short links, payment links, review links where supported) | `links.fortuneandautomations.com` |

Do not place raw HighLevel/LeadConnector URLs in client-facing material. A client-specific branded domain may later override the agency links domain.

## Mobile

Until Fortune & Automations has its own fully white-labeled iOS/Android application:

- Instruct clients to open **app.fortuneandautomations.com** in the phone browser.
- They may save/bookmark the page.
- Do **not** instruct clients to install HighLevel, GoHighLevel, or LeadConnector.
- Do **not** claim an F&A native app exists until it is purchased, built, approved, and deployed.

**WHITE-LABEL MOBILE APP = OPTIONAL FUTURE ADD-ON / NOT REQUIRED FOR CORE MASTER**

Once an actual F&A-branded native app exists, client-facing instructions may reference the F&A app only.

## Google login

Do not enable or recommend Google-login authentication for clients until the complete white-label flow has been manually inspected. If any authentication redirect exposes LeadConnector/HighLevel branding or domains, clients must use branded email/password login instead. This is a branding QA requirement, not an assumption.

## Internal documentation

Operator/developer docs MAY continue using HighLevel, GHL, sub-account, Snapshot, API, location ID, Private Integration, and HighLevel endpoint names. Mark mixed documents **INTERNAL — F&A ONLY** vs **CLIENT-FACING**. Do not global-replace technical instructions.

## Repeatable audit

`python scripts/audit_client_branding.py`  
Classification: `scripts/client_facing_manifest.json`

## Related

- `WHITE_LABEL_ACTIVATION_CHECKLIST.md`
- `WHITE_LABEL_IMPLEMENTATION_GUIDE.md` (INTERNAL agency configuration)
- `CLIENT_QUICK_START.md` (CLIENT-FACING)
