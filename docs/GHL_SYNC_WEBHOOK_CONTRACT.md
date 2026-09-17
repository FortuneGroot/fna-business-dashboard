# GHL Sync Webhook Contract

Hand this document to Grok so outbound **Custom Webhook** actions can be added to the correct HighLevel workflows.

## Architecture ($297 plan)

```
HighLevel workflows / outbound webhooks
  → POST /api/webhooks/ghl
  → F&A normalized sync store
  → Dashboard read APIs + UI
```

HighLevel remains the CRM source of truth. The F&A dashboard does **not** call location CRM list APIs for Contacts / Pipelines / Opportunities / Calendars / Conversations.

## Endpoint

- **URL:** `https://<preview-or-app-host>/api/webhooks/ghl`
- **Method:** `POST`
- **Content-Type:** `application/json`
- **Auth header (when secret configured):** `x-webhook-secret: <GHL_WEBHOOK_SECRET>`  
  (also accepts `x-ghl-signature` with the same shared secret value)

## Global required fields (every event)

| Field | Required | Notes |
|---|---|---|
| `locationId` | YES | Must be live `kIXDnRuhkj6HLR1g6V6V`. Master `NQwD3zdWCuBSVpOuzybj` is rejected. |
| `event` **or** `eventType` **or** `type` | YES | One of the normalized event names below (aliases supported). |
| `idempotencyKey` | Recommended | Stable unique id per delivery. If omitted, the server hashes payload fields. |
| `occurredAt` | Recommended | ISO-8601 timestamp. Defaults to receive time. |
| `contactId` | Usually | External HighLevel contact id when the event is contact-scoped. |

## Safety

- Protected Master location → **409**
- Wrong location → **403**
- Missing/invalid secret when enforcement enabled → **401**
- Unknown event / malformed → **400**
- Duplicate `idempotencyKey` → **200** with `duplicate: true` (no double-apply)

Do not send full SMS/email message bodies for v1. Conversation events accept **summary/metadata only**.

---

## lead.created

**WHEN GHL SHOULD SEND IT:** After WF 10.01 (or adapter 10.02/10.03/10.04) successfully creates/identifies a new sales lead.

**REQUIRED FIELDS:** `locationId`, `event`, `contactId`

**OPTIONAL FIELDS:** `firstName`, `lastName`, `name`, `email`, `phone`, `source`, `tags`, `assignedUser`, `occurredAt`, `idempotencyKey`, nested `contact{}`

**EXAMPLE JSON:**

```json
{
  "event": "lead.created",
  "locationId": "kIXDnRuhkj6HLR1g6V6V",
  "idempotencyKey": "{{workflow.id}}-{{contact.id}}-lead-created",
  "occurredAt": "{{contact.date_added}}",
  "contactId": "{{contact.id}}",
  "firstName": "{{contact.first_name}}",
  "lastName": "{{contact.last_name}}",
  "email": "{{contact.email}}",
  "phone": "{{contact.phone}}",
  "source": "{{contact.source}}",
  "tags": ["lead-new"],
  "assignedUser": "{{user.name}}"
}
```

**DASHBOARD EFFECT:** Upserts CONTACT/LEAD; audit `lead.created`.

---

## lead.updated

**WHEN:** Contact identity/source/assignment changes that matter to the dashboard (post-intake updates).

**REQUIRED:** `locationId`, `event`, `contactId`

**OPTIONAL:** same as `lead.created`

**EXAMPLE JSON:**

```json
{
  "event": "lead.updated",
  "locationId": "kIXDnRuhkj6HLR1g6V6V",
  "idempotencyKey": "{{workflow.id}}-{{contact.id}}-lead-updated-{{contact.date_updated}}",
  "contactId": "{{contact.id}}",
  "firstName": "{{contact.first_name}}",
  "lastName": "{{contact.last_name}}",
  "source": "{{contact.source}}",
  "assignedUser": "{{user.name}}"
}
```

**DASHBOARD EFFECT:** Upserts contact fields.

---

## lead.reply

**WHEN:** Customer replied (WF 80.01 / reply routing) — sync a summary event, not full transcript.

**REQUIRED:** `locationId`, `event`, `contactId`

**OPTIONAL:** `channel`, `direction`, `summary`, `occurredAt`, `idempotencyKey`

**EXAMPLE JSON:**

```json
{
  "event": "lead.reply",
  "locationId": "kIXDnRuhkj6HLR1g6V6V",
  "contactId": "{{contact.id}}",
  "channel": "sms",
  "direction": "inbound",
  "summary": "Customer replied",
  "idempotencyKey": "{{workflow.id}}-{{contact.id}}-reply-{{contact.last_activity}}"
}
```

**DASHBOARD EFFECT:** Upserts contact (if present) + appends conversation event.

---

## lead.qualified

**WHEN:** Lead reaches Qualified stage / qualification confirmed in sales workflows.

**REQUIRED:** `locationId`, `event`, `contactId`

**OPTIONAL:** `opportunityId`, `stageName`, `assignedUser`

**EXAMPLE JSON:**

```json
{
  "event": "lead.qualified",
  "locationId": "kIXDnRuhkj6HLR1g6V6V",
  "contactId": "{{contact.id}}",
  "opportunityId": "{{opportunity.id}}",
  "stageName": "Qualified"
}
```

**DASHBOARD EFFECT:** Contact upsert; opportunity fields if `opportunityId` provided.

---

## opportunity.created

**WHEN:** WF 10.01 creates an open opportunity on Fortune & Automations Sales Pipeline.

**REQUIRED:** `locationId`, `event`, `opportunityId`, `contactId`

**OPTIONAL:** `pipelineId`, `stageId`, `stageName`, `status`, `monetaryValue`, `assignedUser`

**EXAMPLE JSON:**

```json
{
  "event": "opportunity.created",
  "locationId": "kIXDnRuhkj6HLR1g6V6V",
  "contactId": "{{contact.id}}",
  "opportunityId": "{{opportunity.id}}",
  "pipelineId": "6XevPh4T3rX0qAYRfuta",
  "stageName": "New Lead",
  "status": "open",
  "monetaryValue": "{{opportunity.monetary_value}}"
}
```

**DASHBOARD EFFECT:** Upserts OPPORTUNITY (+ contact if ids present).

---

## opportunity.updated

**WHEN:** Opportunity fields change without a stage terminal event.

**REQUIRED:** `locationId`, `event`, `opportunityId`

**OPTIONAL:** `contactId`, `stageName`, `status`, `monetaryValue`, `assignedUser`

**EXAMPLE JSON:**

```json
{
  "event": "opportunity.updated",
  "locationId": "kIXDnRuhkj6HLR1g6V6V",
  "opportunityId": "{{opportunity.id}}",
  "contactId": "{{contact.id}}",
  "monetaryValue": "{{opportunity.monetary_value}}",
  "stageName": "{{opportunity.pipeline_stage}}"
}
```

**DASHBOARD EFFECT:** Opportunity upsert.

---

## opportunity.stage_changed

**WHEN:** Pipeline stage moves (Attempting Contact, Connected, Appointment Booked, etc.).

**REQUIRED:** `locationId`, `event`, `opportunityId`, `stageName` (or `stageId`)

**OPTIONAL:** `contactId`, `status`, `pipelineId`

**EXAMPLE JSON:**

```json
{
  "event": "opportunity.stage_changed",
  "locationId": "kIXDnRuhkj6HLR1g6V6V",
  "opportunityId": "{{opportunity.id}}",
  "contactId": "{{contact.id}}",
  "pipelineId": "6XevPh4T3rX0qAYRfuta",
  "stageName": "Attempting Contact"
}
```

**DASHBOARD EFFECT:** Opportunity stage upsert.

---

## opportunity.won

**WHEN:** WF 40.04 Won Customer.

**REQUIRED:** `locationId`, `event`, `opportunityId`

**OPTIONAL:** `contactId`, `monetaryValue`, `stageName` (defaults to Won)

**EXAMPLE JSON:**

```json
{
  "event": "opportunity.won",
  "locationId": "kIXDnRuhkj6HLR1g6V6V",
  "opportunityId": "{{opportunity.id}}",
  "contactId": "{{contact.id}}",
  "monetaryValue": "{{opportunity.monetary_value}}",
  "stageName": "Won",
  "status": "won"
}
```

**DASHBOARD EFFECT:** Marks opportunity won.

---

## opportunity.lost

**WHEN:** WF 40.05 Lost Lead.

**REQUIRED:** `locationId`, `event`, `opportunityId`

**OPTIONAL:** `contactId`, `stageName` (defaults to Lost)

**EXAMPLE JSON:**

```json
{
  "event": "opportunity.lost",
  "locationId": "kIXDnRuhkj6HLR1g6V6V",
  "opportunityId": "{{opportunity.id}}",
  "contactId": "{{contact.id}}",
  "stageName": "Lost",
  "status": "lost"
}
```

**DASHBOARD EFFECT:** Marks opportunity lost.

---

## appointment.booked

**WHEN:** WF 30.01 Appointment Booked.

**REQUIRED:** `locationId`, `event`, `appointmentId`, `contactId`

**OPTIONAL:** `calendarId`, `calendarName`, `start`, `end`, `timezone`, `assignedUser`, `status`

**EXAMPLE JSON:**

```json
{
  "event": "appointment.booked",
  "locationId": "kIXDnRuhkj6HLR1g6V6V",
  "appointmentId": "{{appointment.id}}",
  "contactId": "{{contact.id}}",
  "calendarId": "{{appointment.calendar_id}}",
  "calendarName": "{{appointment.calendar_name}}",
  "start": "{{appointment.start_time}}",
  "end": "{{appointment.end_time}}",
  "timezone": "US/Eastern",
  "status": "booked"
}
```

**DASHBOARD EFFECT:** Upserts APPOINTMENT.

---

## appointment.rescheduled

**WHEN:** WF 30.03 Appointment Rescheduled.

**REQUIRED:** `locationId`, `event`, `appointmentId`

**OPTIONAL:** `contactId`, `start`, `end`, `timezone`, `status`

**EXAMPLE JSON:**

```json
{
  "event": "appointment.rescheduled",
  "locationId": "kIXDnRuhkj6HLR1g6V6V",
  "appointmentId": "{{appointment.id}}",
  "contactId": "{{contact.id}}",
  "start": "{{appointment.start_time}}",
  "end": "{{appointment.end_time}}",
  "status": "rescheduled"
}
```

**DASHBOARD EFFECT:** Updates appointment times/status.

---

## appointment.cancelled

**WHEN:** WF 30.04 Appointment Cancelled.

**REQUIRED:** `locationId`, `event`, `appointmentId`

**OPTIONAL:** `contactId`, `status`

**EXAMPLE JSON:**

```json
{
  "event": "appointment.cancelled",
  "locationId": "kIXDnRuhkj6HLR1g6V6V",
  "appointmentId": "{{appointment.id}}",
  "contactId": "{{contact.id}}",
  "status": "cancelled"
}
```

**DASHBOARD EFFECT:** Marks appointment cancelled.

---

## appointment.no_show

**WHEN:** WF 30.05 Appointment No Show.

**REQUIRED:** `locationId`, `event`, `appointmentId`

**OPTIONAL:** `contactId`

**EXAMPLE JSON:**

```json
{
  "event": "appointment.no_show",
  "locationId": "kIXDnRuhkj6HLR1g6V6V",
  "appointmentId": "{{appointment.id}}",
  "contactId": "{{contact.id}}",
  "status": "no_show"
}
```

**DASHBOARD EFFECT:** Marks appointment no-show.

---

## appointment.completed

**WHEN:** WF 40.01 Appointment Completed.

**REQUIRED:** `locationId`, `event`, `appointmentId`

**OPTIONAL:** `contactId`, `opportunityId`

**EXAMPLE JSON:**

```json
{
  "event": "appointment.completed",
  "locationId": "kIXDnRuhkj6HLR1g6V6V",
  "appointmentId": "{{appointment.id}}",
  "contactId": "{{contact.id}}",
  "status": "completed"
}
```

**DASHBOARD EFFECT:** Marks appointment completed.

---

## conversation.inbound / conversation.outbound / conversation.handoff

**WHEN:** Reply routing / staff handoff (WF 80.01, WF 20.05, WF 90.02) — summary only.

**REQUIRED:** `locationId`, `event`, `contactId`

**OPTIONAL:** `channel`, `direction`, `summary` (no full message body required)

**EXAMPLE JSON:**

```json
{
  "event": "conversation.inbound",
  "locationId": "kIXDnRuhkj6HLR1g6V6V",
  "contactId": "{{contact.id}}",
  "channel": "sms",
  "direction": "inbound",
  "summary": "Inbound customer message"
}
```

**DASHBOARD EFFECT:** Appends CONVERSATION EVENT (no message-history replication).

---

## review.requested

**WHEN:** WF 60.01 Review Request fires.

**REQUIRED:** `locationId`, `event`, `contactId`

**OPTIONAL:** `resultStatus`, `occurredAt`

**EXAMPLE JSON:**

```json
{
  "event": "review.requested",
  "locationId": "kIXDnRuhkj6HLR1g6V6V",
  "contactId": "{{contact.id}}",
  "resultStatus": "requested"
}
```

**DASHBOARD EFFECT:** Appends REVIEW event.

---

## review.feedback_received

**WHEN:** WF 50.02 Private Feedback / form feedback received.

**REQUIRED:** `locationId`, `event`, `contactId`

**OPTIONAL:** `resultStatus`

**EXAMPLE JSON:**

```json
{
  "event": "review.feedback_received",
  "locationId": "kIXDnRuhkj6HLR1g6V6V",
  "contactId": "{{contact.id}}",
  "resultStatus": "received"
}
```

**DASHBOARD EFFECT:** Appends REVIEW feedback event.

---

## task.created / task.completed

**WHEN:** Internal task workflows create or complete staff tasks (alerts, handoff, hygiene).

**REQUIRED:** `locationId`, `event`

**OPTIONAL:** `contactId`, `opportunityId`, `type`, `status`, `assignedUser`

**EXAMPLE JSON:**

```json
{
  "event": "task.created",
  "locationId": "kIXDnRuhkj6HLR1g6V6V",
  "contactId": "{{contact.id}}",
  "type": "follow-up",
  "status": "open",
  "assignedUser": "{{user.name}}"
}
```

**DASHBOARD EFFECT:** Appends TASK / INTERNAL EVENT.

---

## system.workflow_event

**WHEN:** Catch-all for operational workflow signals that should appear in the audit trail without a stronger entity mapping.

**REQUIRED:** `locationId`, `event`

**OPTIONAL:** `workflowId`, `workflowName`, `contactId`, `summary`

**EXAMPLE JSON:**

```json
{
  "event": "system.workflow_event",
  "locationId": "kIXDnRuhkj6HLR1g6V6V",
  "workflowName": "WF 00.01 Global Do Not Automate",
  "contactId": "{{contact.id}}",
  "summary": "Automation suppressed"
}
```

**DASHBOARD EFFECT:** Audit trail entry (and contact upsert if `contactId` present).

---

## Placeholder note for Grok

Use HighLevel’s native custom-webhook / workflow field pickers for contact, opportunity, and appointment IDs. Do **not** invent object IDs. If a placeholder above is unavailable in a given workflow context, omit the optional field rather than hard-coding a fake value.

## Related

- Implementation map: `docs/GHL_WORKFLOW_SYNC_MAP.md`
- Sync health: `GET /api/sync/health`
- Agency PIT health (unchanged): `GET /api/ghl/health`
