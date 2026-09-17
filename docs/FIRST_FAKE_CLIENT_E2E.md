# First Fake Client E2E — F&A Roofing Test

**Purpose:** First synthetic clone / end-to-end proof after Grok finishes workflow wiring.  
**Client config:** `config/examples/fake-roofing-client.json`  
**Plan:** HighLevel **$297 Unlimited** only — no OAuth / $497 features.

**Rules:**
- No real customer contact, phone, or email.
- Use `@example.invalid` and `+1-555-…` only.
- Never use Master `NQwD3zdWCuBSVpOuzybj`.
- Keep `GHL_DRY_RUN=true`, `ALLOW_PRODUCTION_CONTACT_WRITES=false`, `FAKE_CONTACT_ONLY=true` during this run.
- Do not attach `app.fortuneandautomations.com` or touch Production for this test.

---

## Exact order

### 1. Create fake client location
Create a new HighLevel sub-account named **F&A Roofing Test** (or similar). Record `locationId` into the client config / remap manifest.

### 2. Apply snapshot / clone
Apply the approved Snapshot / clone package into this sub-account only. Confirm you did **not** target the protected Master.

### 3. Remap values
Fill `config/client-remap.template.json` → client-specific file:
- location, pipeline, stages, calendars, users
- support / lead emails (synthetic)
- phone, address/ZIP
- booking / reschedule / review / logo URLs
- webhook destination
- branding + AI business context  
Run Custom Value replacements in GHL to match.

### 4. Verify pipeline
Confirm Fortune-style Sales Pipeline (or client-named copy) exists with expected stage **names**. Save `pipelineId`.

### 5. Verify calendars
Confirm at least one bookable calendar; save `bookingCalendarId` and HTTPS booking/reschedule URLs (placeholders OK only until gate — must be real HTTPS before READY).

### 6. Verify workflow Draft state
Confirm workflows are present and remain **Draft / unpublished** for send actions until QA. Do not enable live customer sends.

### 7. Configure signed sync
- Set Preview `GHL_WEBHOOK_SECRET`
- Point workflow Custom Webhooks at Preview `/api/webhooks/ghl`
- Ensure Supabase URL + service role set if durable store required
- Set `sync.webhookSecretConfigured=true` and destination URL in client JSON  
Confirm `GET /api/sync/health` (`storageMode`, secret flags) and Master rejection still hold.

### 8. Submit fake lead
Submit a fake lead (form or manual enroll) with synthetic identity only.

### 9. Verify GHL contact
Contact exists in **F&A Roofing Test** location only — not Master, not F&A live unless intentionally using live as donor (prefer separate fake location).

### 10. Verify pipeline movement
Opportunity created / stage moves per intake + follow-up design (even if Draft for messaging).

### 11. Verify appointment
Book a test appointment on the fake calendar; confirm appointment record in GHL.

### 12. Verify dashboard sync
Confirm webhook events ingested; `/api/dashboard/summary` no longer empty; contacts/opportunities/appointments reflect sync (not CRM list APIs).

### 13. Verify duplicate protection
Re-send the same webhook / re-trigger with same idempotency key — dashboard must not double-apply.

### 14. Verify review path
Fire review-requested path in Draft/test mode; confirm `review.*` sync event or task without public review spam.

### 15. Run QA
- `npm run check:readiness -- config/examples/fake-roofing-client.json` (expect PARTIAL/BLOCKED until placeholders cleared)
- Sync health + Agency PIT health still OK
- No real SMS/email delivered to humans

### 16. GO / NO-GO
- **GO** only if `docs/CLIENT_GO_LIVE_GATE.md` would pass for a **real** client after replacing synthetic fields.  
- For this fake run: **NO-GO for production**, **GO for “clone path proven”** when sync + pipeline + appointment + duplicate checks pass with Draft messaging.

---

## HIGHLEVEL PLAN

**$297 Unlimited**

**NOT DEPENDENT ON:**
- $497 Agency Pro
- Advanced OAuth
- agency-level CRM API
- white-label native mobile app add-on
