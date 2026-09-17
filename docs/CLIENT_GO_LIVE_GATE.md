# Client Go-Live Gate

A client may **not** be marked **READY** until every item below is true.

Use:
- `scripts/check-client-readiness.ts` → status must be `READY`
- `GET /api/onboarding/readiness` → same
- Fake E2E complete per `docs/FIRST_FAKE_CLIENT_E2E.md` (with real client values substituted)

Protected Master (always fail closed):  
`NQwD3zdWCuBSVpOuzybj`

---

## Hard requirements

- [ ] No Master location IDs anywhere in client config / remap / Custom Values
- [ ] No `REPLACE_ME` / placeholder URLs remaining
- [ ] Pipeline mapped (`pipelineId` + stage names/IDs)
- [ ] Calendars mapped (primary booking calendar + booking/reschedule URLs)
- [ ] Staff mapped (`assignedUserIds` non-empty, real IDs)
- [ ] Phone mapped
- [ ] Support + lead notification emails mapped (non-synthetic)
- [ ] Review link mapped (https)
- [ ] Logo URL mapped (https)
- [ ] Signed webhook working (`webhookSecretConfigured` + successful ingest)
- [ ] Dashboard sync working (`/api/sync/health` shows events; dashboard not empty after test)
- [ ] Workflow QA passed (Grok/owner sign-off; Draft→publish only as planned)
- [ ] Fake contact E2E passed before any real contact
- [ ] No real sends happened during test (`dryRun` / Draft / fake-only)
- [ ] A2P requirements satisfied where SMS is enabled
- [ ] Client-specific permissions verified (users, locations, no cross-location bleed)

---

## Safety flags at go-live decision

Document the intended production posture explicitly:

| Flag | Typical pre-go-live | Go-live decision |
|---|---|---|
| `GHL_DRY_RUN` | `true` | Owner-controlled flip |
| `ALLOW_PRODUCTION_CONTACT_WRITES` | `false` | Remain false unless product requires writes |
| `FAKE_CONTACT_ONLY` | `true` | Must be `false` only after gate PASS |

Dashboard CRM writes are **not** required for the $297 webhook sync architecture.

---

## HIGHLEVEL PLAN

**$297 Unlimited**

**NOT DEPENDENT ON:**
- $497 Agency Pro
- Advanced OAuth
- agency-level CRM API
- white-label native mobile app add-on

If a step appears to “need” any of the above, **stop** and redesign for webhook + Snapshot + Custom Values on $297.
