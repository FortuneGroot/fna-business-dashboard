# GHL Workflow → Dashboard Sync Map

**Purpose:** Tell Grok which outbound webhook events to add to which canonical workflows.  
**Do not modify HighLevel from this document** — map only.

Live location: `kIXDnRuhkj6HLR1g6V6V`  
Protected Master (never sync): `NQwD3zdWCuBSVpOuzybj`  
Ingest: `POST /api/webhooks/ghl`  
Contract details: `docs/GHL_SYNC_WEBHOOK_CONTRACT.md`

## Priority guide

1. Core revenue path (intake → reply → book → won/lost)
2. Appointment lifecycle + reviews
3. Optional modules / tests / hygiene

---

## Master / safety workflows

| Workflow | Outbound sync events | Notes |
|---|---|---|
| WF 00.01 Global Do Not Automate | `system.workflow_event` | Optional; audit only. No CRM list reads. |
| WF 00.02 Manual Resume Review | `system.workflow_event`, `task.created` | Staff release valve. |

---

## 10 LEAD CAPTURE

| Workflow | Outbound sync events | Notes |
|---|---|---|
| WF 10.01 New Lead - Master Intake | `lead.created`, `lead.updated`, `opportunity.created` | Primary intake fan-in. Send after identity + opportunity find/create. |
| WF 10.02 Website Form Intake | `lead.created` (or rely on 10.01) | Prefer single emit from 10.01 to avoid duplicates; if adapter emits, use stable idempotency keys. |
| WF 10.03 Chat Lead Intake | `lead.created` / `conversation.inbound` | Chat identity collected → lead; active chat reply may be conversation event. |
| WF 10.04 Manual Lead Intake | `lead.created` | Staff enrollments. |

---

## 20 LEAD FOLLOW-UP

| Workflow | Outbound sync events | Notes |
|---|---|---|
| WF 20.01 New Lead - Immediate Response | `conversation.outbound`, `opportunity.stage_changed` | First ack send + stage 01→02. |
| WF 20.02 Missed Call Text Back | `conversation.outbound`, `lead.updated` | One guarded text-back. |
| WF 20.03 After Hours Response | `conversation.outbound` | After-hours ack. |
| WF 20.04 No Response Follow-Up | `conversation.outbound`, `opportunity.stage_changed` | Follow-up cadence. |
| WF 20.05 Human Handoff | `conversation.handoff`, `task.created` | Staff takeover. |

---

## 30 APPOINTMENTS

| Workflow | Outbound sync events | Notes |
|---|---|---|
| WF 30.01 Appointment Booked | `appointment.booked`, `opportunity.stage_changed` | Also move stage to Appointment Booked when applicable. |
| WF 30.02 Appointment Reminder | `system.workflow_event` (optional) | Reminder sends; sync optional for v1. |
| WF 30.03 Appointment Rescheduled | `appointment.rescheduled` | Update start/end. |
| WF 30.04 Appointment Cancelled | `appointment.cancelled` | |
| WF 30.05 Appointment No Show | `appointment.no_show` | |

---

## 40 SALES

| Workflow | Outbound sync events | Notes |
|---|---|---|
| WF 40.01 Appointment Completed | `appointment.completed`, `opportunity.stage_changed` | |
| WF 40.02 Estimate / Proposal Sent | `opportunity.stage_changed`, `conversation.outbound` | |
| WF 40.03 Decision Pending | `opportunity.stage_changed` | |
| WF 40.04 Won Customer | `opportunity.won` | |
| WF 40.05 Lost Lead | `opportunity.lost` | |
| WF 40.06 Long-Term Nurture | `opportunity.stage_changed`, `system.workflow_event` | |

---

## 50–60 EXPERIENCE / REVIEWS

| Workflow | Outbound sync events | Notes |
|---|---|---|
| WF 50.01 Service Completed | `system.workflow_event`, `task.created` | |
| WF 50.02 Private Feedback | `review.feedback_received` | |
| WF 60.01 Review Request | `review.requested` | |

---

## 70–90 OPS / AI

| Workflow | Outbound sync events | Notes |
|---|---|---|
| WF 70.01 Past Lead Reactivation | `lead.updated`, `conversation.outbound` | |
| WF 80.01 Customer Reply Routing | `lead.reply`, `conversation.inbound` | Summary only — no full message body. |
| WF 80.02 AI Summary & Escalation | `conversation.handoff`, `task.created` | |
| WF 90.01 Internal Alert Dispatcher | `task.created` | Internal alert → task/event. |
| WF 90.02 Staff Took Over | `conversation.handoff`, `task.created` | |
| WF 90.03 Manual Error & Hygiene Review | `task.created`, `system.workflow_event` | |

---

## 95 OPTIONAL MODULES

| Workflow | Outbound sync events | Notes |
|---|---|---|
| WF 95.01–95.07 Intake Adapters | `lead.created` (prefer via 10.01) | Adapters should funnel into 10.01; avoid duplicate lead.created unless idempotent. |
| WF 95.08 Social Draft Review | `task.created` | |

---

## 98 TESTING

| Workflow | Outbound sync events | Notes |
|---|---|---|
| WF 98.01 TEST \| New Lead | `lead.created` | Use fake contacts only while `FAKE_CONTACT_ONLY=true`. |
| WF 98.02 TEST \| Appointment | `appointment.booked` | |
| WF 98.03 TEST \| Missed Call | `conversation.outbound` | |
| WF 98.04 TEST \| Estimate Follow-Up | `opportunity.stage_changed` | |
| WF 98.05 TEST \| Review Request | `review.requested` | |
| WF 98.06 TEST \| AI Handoff | `conversation.handoff` | |

---

## Implementation rules for Grok

1. Add **Custom Webhook** (or equivalent outbound HTTP) actions only — do not redesign workflow logic here.
2. Always include live `locationId`.
3. Always set a stable `idempotencyKey` (workflow + contact/opportunity/appointment + event + timestamp/version).
4. Prefer emitting from the **canonical owner workflow** (e.g. 10.01, 30.01, 40.04) rather than every adapter.
5. Never target the protected Master location.
6. Do not enable live customer sends as part of sync wiring.
7. After wiring, verify `GET /api/sync/health` shows rising counts and `GET /api/dashboard/summary` is no longer `waitingForSync`.
