# Client deployment runbook

One client = one dashboard deployment = one `ClientConfig` + one Vercel Preview/Production env.

HighLevel plan: **$297 Unlimited only**. No $497 Agency Pro, Advanced OAuth, or agency CRM list APIs.

## Sequence

### 1. Client config
Copy `config/examples/fake-roofing-client.json` (or start from F&A LIVE defaults via empty `CLIENT_CONFIG_PATH`).
Fill real cloned GHL values:
- locationId, pipelineId, stageIds, calendarIds, assignedUserIds
- booking/reschedule/review URLs, emails, logo, webhook destination

### 2. Validate
```bash
npm run client:prepare -- path/to/client.json
# or
npm run client:validate -- path/to/client.json
```
Expect `READY` only when placeholders are gone and required secret **presence** flags pass.

### 3. Generate non-secret manifest
```bash
npm run client:generate -- path/to/client.json --out generated/client-manifest.json
```
Manifest never contains secret values. It lists OWNER REQUIRED secrets as presence placeholders.

### 4. Owner adds secrets (Vercel / `.env.local`)
Set (values never committed / never printed):
- `GHL_API_TOKEN`
- `GHL_WEBHOOK_SECRET` (per deployment)
- `AUTH_SECRET`
- `AUTH_OWNER_EMAIL` / `AUTH_OWNER_PASSWORD`
- optional `AUTH_ADMIN_*`, `AUTH_CLIENT_*`
- optional `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`

Also set non-secrets from the manifest:
- `CLIENT_CONFIG_PATH`
- `GHL_LOCATION_ID`, `GHL_PIPELINE_ID`
- `GHL_DRY_RUN=true` until go-live
- `ALLOW_PRODUCTION_CONTACT_WRITES=false`
- `GHL_WEBHOOK_ENFORCE_SECRET=true` for Preview/Production

### 5. Preview deploy
Point Vercel at this repo folder. Enable **Vercel Deployment Protection** for Preview.
Deploy. Confirm `/api/health` is up.

### 6. Webhook test
Grok-owned workflows POST to `/api/webhooks/ghl` with:
- configured client `locationId`
- header `x-webhook-secret` matching this deployment’s `GHL_WEBHOOK_SECRET`
Master location `NQwD3zdWCuBSVpOuzybj` is always refused.

### 7. Fake E2E
Use synthetic contacts (`@example.invalid`) only while `FAKE_CONTACT_ONLY=true`.
Confirm dashboard lists populate from sync (not CRM list APIs).

### 8. Authentication test
With `AUTH_SECRET` set:
- unauthenticated `/dashboard` → `/login`
- owner/admin/client credentials create httpOnly session cookie
- `/api/dashboard/*` returns 401 without session
- webhook route remains machine-accessible with webhook secret

### 9. Go-live gate
See `docs/CLIENT_GO_LIVE_GATE.md`. Keep production writes off until explicitly authorized.

## Per-client webhook security (V1)

- Each deployment has its own `GHL_WEBHOOK_SECRET` in Vercel.
- Secret stays server-side — not in GHL Custom Values, not in browser, never printed.
- Readiness reports PRESENT/MISSING only.
- Future multi-client shared secret store is out of scope for V1.

## Auth roles (V1)

| Role | Access |
|------|--------|
| OWNER | Full dashboard for this deployment |
| ADMIN | Full operational dashboard for this deployment |
| CLIENT | Full dashboard for this one-client deployment |

Row-level multi-tenancy is unnecessary while one client = one deploy.
