# Client Clone Manifest ($297)

Separate what the system can prepare automatically vs what the owner must do in HighLevel / ops.

**Plan:** `$297 Unlimited` only.  
**NOT INCLUDED:** `$497 Agency Pro`, Advanced OAuth, agency-level CRM API, white-label native mobile add-on.

Protected Master (never clone into / as client): `NQwD3zdWCuBSVpOuzybj`

---

## GHL snapshot

| AUTOMATIC | MANUAL OWNER STEP | VERIFY | BLOCKER |
|---|---|---|---|
| Remap template lists fields to capture after Snapshot | Create sub-account; apply approved Snapshot into **client** location only | `locationId` ≠ Master; account name matches client | Snapshot applied to Master or wrong location |

## Custom values

| AUTOMATIC | MANUAL OWNER STEP | VERIFY | BLOCKER |
|---|---|---|---|
| Config / remap holds target values; readiness flags blanks/placeholders | Paste Support Email, Lead Notification Email, Logo/Booking/Reschedule/Review URLs, ZIP into GHL CVs | Values match `ClientConfig`; no `REPLACE_ME` | Workflows use donor F&A values |

## Phone

| AUTOMATIC | MANUAL OWNER STEP | VERIFY | BLOCKER |
|---|---|---|---|
| Config stores `phoneNumber` | Buy/assign LC number on sub-account | Number on client location; config updated | No number → SMS paths cannot go live |

## A2P

| AUTOMATIC | MANUAL OWNER STEP | VERIFY | BLOCKER |
|---|---|---|---|
| Checklist + channel flags (`smsEnabled=false` until approved) | Complete brand/campaign registration for client | A2P approved before `smsEnabled=true` | Enabling SMS without A2P |

## Staff

| AUTOMATIC | MANUAL OWNER STEP | VERIFY | BLOCKER |
|---|---|---|---|
| Readiness requires `assignedUserIds` | Invite users; map owner/sales IDs into config + calendar hosts | At least one real user ID; calendars hosted | Unassigned routing / empty staff map |

## Calendar

| AUTOMATIC | MANUAL OWNER STEP | VERIFY | BLOCKER |
|---|---|---|---|
| Config holds `bookingCalendarId` + `calendarIds` + booking/reschedule URLs | Confirm calendars exist post-Snapshot; set hosts; copy public links | Bookable test slot; HTTPS URLs | Missing calendar → appointment sync blocked |

## Email

| AUTOMATIC | MANUAL OWNER STEP | VERIFY | BLOCKER |
|---|---|---|---|
| Config holds support + lead notification emails | Configure sending domain / mailbox on sub-account | Test message in Draft/sandbox; not placeholder for go-live | No mailbox → email sequences fail |

## Reviews

| AUTOMATIC | MANUAL OWNER STEP | VERIFY | BLOCKER |
|---|---|---|---|
| Config `reviewUrl` + review sync events | Provide Google (or approved) review link; set CV | HTTPS opens; review workflow references client link | Missing review URL |

## Webhook

| AUTOMATIC | MANUAL OWNER STEP | VERIFY | BLOCKER |
|---|---|---|---|
| Dashboard ingest + idempotency + sync health already built | Set Preview `GHL_WEBHOOK_SECRET`; point Custom Webhooks at `/api/webhooks/ghl` (Grok wiring); set `webhookSecretConfigured=true` + destination in config | Signed test event lands; Master rejected; duplicates ignored | No signed webhook → dashboard empty |

## Branding

| AUTOMATIC | MANUAL OWNER STEP | VERIFY | BLOCKER |
|---|---|---|---|
| Config colors/logo fields; readiness checks colors | Supply logo/favicon URLs + palette | Branding fields complete; no HighLevel leakage in client copy | Incomplete branding for white-label feel |

## Dashboard

| AUTOMATIC | MANUAL OWNER STEP | VERIFY | BLOCKER |
|---|---|---|---|
| Sync store + read APIs + waiting-for-sync UI | Confirm Supabase Preview env if durable; run fake lead E2E | `/api/dashboard/summary` populates after webhooks | Durable store missing in multi-instance Preview |

## Domain

| AUTOMATIC | MANUAL OWNER STEP | VERIFY | BLOCKER |
|---|---|---|---|
| Config `domain` / app host fields | DNS + Vercel domain only when owner authorizes (not during fake E2E) | Domain points at correct project; Production untouched until gate | Premature Production domain attach |

---

## Related

- `docs/CLIENT_ONBOARDING_CHECKLIST.md`
- `docs/FAST_CLIENT_ONBOARDING.md`
- `docs/FIRST_FAKE_CLIENT_E2E.md`
- `docs/CLIENT_GO_LIVE_GATE.md`
- `config/client-remap.template.json`
