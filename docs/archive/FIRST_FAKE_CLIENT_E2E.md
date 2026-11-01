# First Fake Client E2E — F&A Roofing Test

**Purpose:** First synthetic clone / end-to-end proof after Grok finishes workflow wiring.  
**Client config:** `config/examples/fake-roofing-client.json`  
**Remap:** copy `config/client-remap.template.json` → client-specific remap file  
**Plan:** HighLevel **$297 Unlimited** only — no OAuth / $497 features.

**Rules:**
- No real customer contact, phone, or email.
- Use `@example.invalid` and `+1-555-…` only.
- Never use Master `NQwD3zdWCuBSVpOuzybj`.
- Keep `GHL_DRY_RUN=true`, `ALLOW_PRODUCTION_CONTACT_WRITES=false`, `FAKE_CONTACT_ONLY=true` during this run.
- Do not attach `app.fortuneandautomations.com` or touch Production for this test.
- Do not modify GHL workflows while Grok owns that lane — only configure webhook destinations/secrets after actions exist.

---

## Exact operational order

### 1. Create GHL sub-account
Create sub-account **F&A Roofing Test**. Record `locationId` into fake client JSON + remap. Confirm ≠ Master.

### 2. Apply snapshot / clone
Apply approved Snapshot into this sub-account only.

### 3. Remap values
Fill location, pipeline, **stageIds**, **calendarIds**, users, synthetic emails, phone, URLs, branding, AI context. Update GHL Custom Values to match.

### 4. Verify pipeline
Confirm pipeline + stage names; save `pipelineId` and each stage ID.

### 5. Verify calendars
Confirm bookable calendar(s); save `bookingCalendarId`, `calendarIds`, booking/reschedule HTTPS links (may still be REPLACE_ME until links exist).

### 6. Verify workflow Draft state
Workflows present; send actions remain Draft/unpublished. No live customer sends.

### 7. Configure signed sync
- Preview `GHL_WEBHOOK_SECRET`
- Custom Webhooks → Preview `/api/webhooks/ghl`
- Supabase Preview env if durable required
- Set `webhookDestination` + `webhookSecretConfigured=true` in config  
Confirm `/api/sync/health` and Master rejection.

### 8. Submit fake lead
Synthetic identity only (`@example.invalid`).

### 9. Verify GHL contact
Contact in **F&A Roofing Test** location only.

### 10. Verify pipeline movement
Opportunity created / stage moves per intake design.

### 11. Verify appointment
Book test appointment on fake calendar.

### 12. Verify dashboard sync
Webhook ingest → `/api/dashboard/summary` and entity routes populate (not CRM list APIs).

### 13. Verify duplicate protection
Same idempotency key → no double-apply.

### 14. Verify review path
`review.requested` (or equivalent) sync without public spam.

### 15. Run QA
```bash
npm run check:readiness -- config/examples/fake-roofing-client.json
curl -s localhost:3000/api/onboarding/readiness
```
Expect **BLOCKED** or **PARTIAL** until REPLACE_ME IDs / synthetic emails cleared. Sync health PASS. No real SMS/email to humans.

### 16. GO / NO-GO
- **GO (clone path proven):** fake lead + pipeline + appointment + signed webhook + dashboard + idempotency with Draft messaging.
- **NO-GO (production / real client):** until `docs/CLIENT_GO_LIVE_GATE.md` PASS with non-synthetic values.

---

## HIGHLEVEL PLAN

**$297 Unlimited**

**NOT DEPENDENT ON:**
- $497 Agency Pro
- Advanced OAuth
- agency-level CRM API
- white-label native mobile app add-on
