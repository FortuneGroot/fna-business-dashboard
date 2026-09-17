# Fast Client Onboarding (30-minute path)

**Goal:** Shortest *safe* path from signed client → usable $297 system.  
**Does not fake** HighLevel Snapshot, A2P, DNS, or Grok workflow completion.

**HARD PLAN:** `$297 Unlimited` only — no OAuth / $497 / agency CRM API.

Prereqs before the clock starts:
- Grok workflow pack exists for the donor Snapshot
- Preview app + webhook secret + Supabase (if durable) already available
- Client intake answers collected (name, emails, phone preference, review URL, logo)

---

## 0–5 min — Identity lock

1. Create sub-account named for the client (never Master `NQwD3zdWCuBSVpOuzybj`).
2. Copy `config/client-remap.template.json` → `config/clients/<slug>-remap.json`.
3. Write `businessName`, legal name, timezone, support + lead emails into remap + `ClientConfig`.
4. Run `npm run check:readiness -- <config>` — expect **BLOCKED** (IDs still missing). That is OK.

## 5–10 min — Snapshot + IDs

1. Apply approved Snapshot into the **new** sub-account.
2. Record `locationId`, `pipelineId`, primary `bookingCalendarId`.
3. Paste stage IDs into `ghl.stageIds` (by stage name).
4. Paste calendar IDs into `ghl.calendarIds`.
5. Invite / confirm at least one staff user → `assignedUserIds`.

## 10–20 min — Values + channels (safe defaults)

1. Replace Custom Values in GHL (support, lead notify, logo, booking, reschedule, review, ZIP).
2. Set booking/reschedule/review/logo **https** URLs in config.
3. Leave `smsEnabled=false` unless A2P already approved.
4. Leave AI send features off unless client bought AI and copy is approved.
5. Point Custom Webhooks (or confirm Grok-added actions) at Preview `/api/webhooks/ghl` with secret header.
6. Set `sync.webhookSecretConfigured=true` + destination URL in config.

## 20–30 min — Prove the loop

1. Submit **fake** lead (`@example.invalid` / 555) only.
2. Confirm contact + opportunity in **client** location.
3. Book a test appointment.
4. Confirm `/api/sync/health` and `/api/dashboard/summary` update.
5. Re-fire duplicate webhook → idempotent.
6. Re-run readiness checker — aim for **PARTIAL** (synthetic emails) or **READY** if real client emails used.

### 30-min exit criteria (usable internal system)

- Sub-account live with Snapshot
- Pipeline + calendar IDs captured
- Custom Values remapped
- Signed webhook → dashboard sync proven with fake contact
- SMS/AI/domain **not** required for “usable” internal ops view

---

## POST-30-MIN MANUAL DEPENDENCIES

These cannot be honestly finished inside 30 minutes for every client:

| Dependency | Why it stays manual |
|---|---|
| A2P / 10DLC approval | Carrier timelines |
| Production custom domain | DNS + Production env owner approval |
| Real review ranking / GBP verification | Google / client ownership |
| Full workflow publish of all send paths | Requires QA + consent + hours |
| Stripe / payments | Client processor onboarding |
| Voice AI / Conversation AI go-live | Copy + escalation + policy review |
| Staff training | Human time |
| Real customer cutover | Go-live gate (`docs/CLIENT_GO_LIVE_GATE.md`) |

---

## Related

- `docs/CLIENT_CLONE_MANIFEST.md`
- `docs/FIRST_FAKE_CLIENT_E2E.md`
- `docs/297_FEATURE_MATRIX.md`
