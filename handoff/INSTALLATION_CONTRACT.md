# Installation contract — GHL snapshot ↔ Next.js app

## Architecture (explicit)

**Deployment-per-client (V1).**  
One Vercel project deployment + one `CLIENT_CONFIG_PATH` (or embedded default) + one `GHL_LOCATION_ID` + one `GHL_WEBHOOK_SECRET`.

This is **not** a shared multi-tenant router. Do not market the F&A live deployment as safely shared by unlimited clients. A new client needs its **own** deployment (or at minimum a fully remapped config + secrets + webhook endpoint) before activation.

## Deliverables are separate

| Deliverable | Owner | Notes |
|---|---|---|
| GHL Snapshot / workflows / forms / calendars | Grok (GHL) | Stay Draft/OFF until approved |
| Next.js + Supabase app | Cursor (this repo) | This contract |
| Release / Production deploy | Claude | After gates |

## GHL assets the app expects

From tenant config (`ClientConfig` schema 1.0):

- Location ID (never Master)
- Pipeline ID + stage ID map
- Booking calendar ID + calendar ID map
- Assigned user IDs
- Booking / reschedule / review URLs (client-owned)
- Branding tokens (logo/colors) for public chrome
- Business identity (name, timezone, support email for readiness)

Webhook Custom Webhook cards should POST to **this deployment’s** `/api/webhooks/ghl` with header `x-webhook-secret` (or `x-ghl-signature`) matching **this** deployment’s secret.

## Database migrations (apply status unknown until Claude/ops confirms)

| File | Purpose |
|---|---|
| `supabase/migrations/20260917_sync_store.sql` | Sync tables + Master location check constraints |
| `supabase/migrations/20260917_auth_sessions.sql` | Durable `auth_sessions` |

Apply in the **client’s** Supabase project before enabling Production auth/sync.  
This overnight branch does **not** apply migrations remotely.

## Environment variables (names only)

| Name | Purpose | Scope | Validation |
|---|---|---|---|
| `AUTH_SECRET` | Session HMAC | Server | Required Production; fail-closed if missing |
| `AUTH_OWNER_EMAIL` / `AUTH_OWNER_PASSWORD` | Owner login | Server | Required for READY gate |
| `AUTH_ADMIN_*` / `AUTH_CLIENT_*` | Role logins | Server | Optional but recommended |
| `AUTH_FAIL_CLOSED` | Force fail-closed outside Production | Server | `true`/`false` |
| `SUPABASE_URL` | PostgREST base | Server | Must be https URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Durable store key | Server | `sb_secret_` or legacy JWT; never `NEXT_PUBLIC_*` |
| `GHL_LOCATION_ID` | Deployment-bound location | Server | Must match config; never Master |
| `GHL_PIPELINE_ID` | Deployment-bound pipeline | Server | Must match config; not retired ID |
| `GHL_WEBHOOK_SECRET` | Ingest auth | Server | Unique per deployment |
| `GHL_WEBHOOK_ENFORCE_SECRET` | Force secret in dry-run | Server | Production enforces anyway |
| `GHL_API_TOKEN` | Optional CRM read | Server | pit-…; never Master token |
| `GHL_DRY_RUN` | Block CRM writes | Server | Keep `true` until authorized |
| `CLIENT_CONFIG_PATH` | Per-client JSON | Server | Path to config file |
| `FAKE_CONTACT_ONLY` | Test email filter | Server | Keep true in dry-run |

Never put privileged values in `NEXT_PUBLIC_*`.

## Keeping a new client disconnected from F&A live

1. Create a **new** Vercel project (or Preview with separate env) — do not reuse F&A Production webhook secret.
2. Point `CLIENT_CONFIG_PATH` at the client JSON with **their** location/pipeline/calendars.
3. Set `GHL_LOCATION_ID` / `GHL_PIPELINE_ID` to match that JSON.
4. Provision **new** `GHL_WEBHOOK_SECRET` and wire GHL Custom Webhooks to the **new** host only.
5. Use a **separate** Supabase project (recommended) so session/sync tables are not shared.
6. Leave workflows Draft/OFF until install doctor + readiness are non-BLOCKED.
7. Do not copy F&A owner passwords, recipient emails, or live location IDs into the client config.

## Installation order

1. Import Snapshot into empty client location (Grok) — Draft/OFF.
2. Remap Custom Values, forms, calendars, staff (Grok).
3. Create Supabase project; apply migrations (ops/Claude).
4. Create Vercel project from this app; set env names (Claude).
5. Add `config/clients/<slug>.json` + `CLIENT_CONFIG_PATH`.
6. Run `npm run install:doctor -- config/clients/<slug>.json`.
7. Run `npm run client:validate` / readiness.
8. Deploy Preview; anonymous `verify:auth`; then credentialed owner test.
9. Point GHL webhooks at Preview/Production URL; test with **invalid** secret first (401).
10. Only then enable selected workflows (separate approval).

## Post-install validation

```bash
npm run install:doctor -- path/to/client.json
npm run client:validate -- path/to/client.json
npm test
npm run release:security
node scripts/verify-auth-runtime.mjs https://<this-deployment>
```

## Doctor command

`npm run install:doctor` — non-mutating; prints configured/missing/invalid **flags**, never secret values. Exit 1 on Master or BLOCKED deployment status.

## Secret rotation (procedure only)

1. Generate new webhook secret offline.
2. Update Vercel env for the deployment.
3. Update GHL Custom Webhook header to the new value.
4. Confirm unsigned POST → 401; wrong secret → 401.
5. Rotate Auth passwords / Supabase keys only with owner approval; never commit values.
