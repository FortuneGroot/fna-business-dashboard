# WHITE LABEL — FINAL SETUP

Goal: the client experience feels like **Fortune & Automations Business Dashboard**,
not HighLevel. Intended login: `app.fortuneandautomations.com`.
**Do not change DNS tonight.** $0 — white-label controls are on the agency plan.

## Do now (supported, no DNS, no cost)

| Control | Value | Where |
|---|---|---|
| Agency / product name | `Fortune & Automations Business Dashboard` | Agency → Settings → Company / Rebranding |
| Primary colour | `#17324F` | rebranding theme |
| Sidebar colour | `#10263B` | theme |
| Accent | `#C7A16A` | theme |
| Login / dark background | `#0A1827` | rebranding |
| Page background | `#F2EDE5` | theme |
| Logo (expanded) | F&A wordmark on `#0A1827` | rebranding uploads |
| Logo (collapsed) / favicon | F&A monogram, gold on darkest navy | rebranding uploads |
| Support email shown to clients | `Automations@fortuneandfinance.com` | rebranding |
| Help/knowledge links | F&A's own or removed | rebranding |
| Mobile app name (LeadConnector rebrand) | `Fortune & Automations` | mobile app branding (no cost to set the name) |
| Login page copy | "Fortune & Automations Business Dashboard" | rebranding |
| Google sign-in | **OFF** until the full white-label redirect is inspected | auth settings |
| Sub-account naming | `F&A MASTER CORE - DO NOT USE LIVE - v1.0` (master) / client name (clones) | sub-account settings |

## Client-materials rule
Every client-facing link (form, calendar, review, funnel, email footer) must use
`links.fortuneandautomations.com` or an approved client domain — **never** raw
`gohighlevel.com` / `leadconnector` / `msgsndr` URLs. Client instructions reference
`app.fortuneandautomations.com` only. No "install the LeadConnector app" wording.

## Owner future steps (DNS — NOT tonight, no cost from us)
1. At the F&A domain registrar, add a CNAME: `app` → the HighLevel white-label target (HighLevel shows the exact target in Agency → Custom Domain when you enter the domain — **capture that string, do not click any purchase**).
2. Add `links` → the LC links target.
3. Wait for propagation, then verify in HighLevel.
4. Re-inspect the Google auth redirect before enabling Google sign-in.

## Verification
- Client login shows F&A wordmark + navy background, no HighLevel branding.
- Sidebar is `#10263B` with the F&A logo.
- A test form/calendar link is on `links.` (once DNS done) or the raw link is not exposed in any client doc.
- QA row "white-label presentation" passes.
