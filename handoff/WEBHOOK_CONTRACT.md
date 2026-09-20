# Webhook contract (derived from current code)

**Source of truth:** `src/app/api/webhooks/ghl/route.ts`, `src/lib/sync/ingest.ts`, `src/lib/sync/events.ts`, `src/lib/sync/types.ts`  
**Local fixtures:** `tests/fixtures/webhooks/*.json`  
**Do not** submit valid authenticated events to Production from overnight work.

## Endpoint

| Item | Value |
|---|---|
| Method | `POST` |
| Path | `/api/webhooks/ghl` |
| Auth | Machine secret headers (not login cookies) |
| Middleware | Public (no HTML login redirect) |

## Headers

| Header | Role |
|---|---|
| `x-webhook-secret` | Preferred shared secret; compared timing-safe to `GHL_WEBHOOK_SECRET` |
| `x-ghl-signature` | Accepted alternate header carrying the same shared secret value |

**Not** an HMAC of the body. Equality check against configured secret.

### Enforcement

- If `GHL_WEBHOOK_SECRET` is set → header must match.
- If `GHL_WEBHOOK_ENFORCE_SECRET=true` **or** `GHL_DRY_RUN=false` → secret required.
- Route also sets enforce when `VERCEL_ENV=production` (Production always requires secret even if dry-run).

## Accepted event names

Canonical (`SYNC_EVENT_TYPES`):

- Lead: `lead.created`, `lead.updated`, `lead.reply`, `lead.qualified`
- Opportunity: `opportunity.created`, `opportunity.updated`, `opportunity.stage_changed`, `opportunity.won`, `opportunity.lost`
- Appointment: `appointment.booked`, `appointment.rescheduled`, `appointment.cancelled`, `appointment.no_show`, `appointment.completed`
- Conversation: `conversation.inbound`, `conversation.outbound`, `conversation.handoff`
- Review: `review.requested`, `review.feedback_received`
- Task: `task.created`, `task.completed`
- System: `system.workflow_event`

Aliases (examples): `ContactCreate` → `lead.created`, `appointment.noshow` → `appointment.no_show`, `inboundmessage` → `conversation.inbound`. See `events.ts` for the full map.

Event resolved from first present: `eventType` | `event_name` | `event` | `type`.

## Required JSON fields

| Field | Rule |
|---|---|
| Valid JSON object | Else 400 malformed |
| `locationId` or `location_id` | Required |
| Known event name | Else 400 `unknown_event` |
| Entity IDs (`contactId`, `opportunityId`, `appointmentId`, …) | Optional; upserts only when present for that family |

Timestamps: `occurredAt` / `occurred_at` / `timestamp` optional; used in audit + auto idempotency digest.

## Tenant / Master rules

1. Protected Master location → **409** `master_refused` (absolute).
2. `locationId` must equal this deployment’s `GHL_LOCATION_ID` / tenant config location → else **403** `wrong_location`.
3. Architecture is **deployment-per-client**. Caller-provided location IDs cannot retarget another tenant.

## Idempotency

- Explicit: `idempotencyKey` | `idempotency_key` | `eventId` | `event_id`
- Else auto SHA-256 of event+location+entity ids+timestamp+rawBody
- Duplicate → **200** `{ duplicate: true, processed: false }`

## Response codes

| Code | Meaning |
|---|---|
| 400 | Invalid JSON / malformed / unknown event |
| 401 | Missing/wrong webhook secret |
| 403 | Wrong location for this deployment |
| 409 | Protected Master refused |
| 200 | Accepted (including duplicates) |

Success body shape: `ok`, `accepted`, `processed`, `duplicate?`, `eventType?`, `dryRun`, `message?`.

## Retry interpretation (for GHL operators)

- **401/403/409** → fix configuration; do not blind-retry the same bad payload forever.
- **400** → fix payload shape/event name.
- **200 duplicate** → safe; prior delivery already stored.
- **5xx** → transient; retry with backoff.

## Local verification

```bash
npm test -- tests/webhook-contract.test.ts
```

Uses throwaway memory store + synthetic location `loc_synth_ready_001`. Never hits Production.
