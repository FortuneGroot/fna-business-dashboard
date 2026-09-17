# Fortune & Automations Business Dashboard

Production-quality Next.js shell for **one client per deployment** on HighLevel **$297 Unlimited**.

Sync model: HighLevel **workflow webhooks** → durable SyncStore → dashboard.  
No Advanced OAuth. No agency CRM list APIs. No $497-only features.

## Source workflow

1. Edit client JSON under `config/`
2. `npm run client:prepare -- config/path.json`
3. `npm run client:generate -- config/path.json --out generated/manifest.json`
4. Owner sets secrets in Vercel (never commit)
5. Preview deploy + webhook test + auth test
6. Go-live gate (`docs/CLIENT_GO_LIVE_GATE.md`)

See **`docs/CLIENT_DEPLOYMENT_RUNBOOK.md`**.

## Local

```bash
cp .env.example .env.local
npm install
npm test
npm run dev
```

Open http://localhost:3000 → redirects to `/login`.

## Preview env requirements

Non-secret:
- `CLIENT_CONFIG_PATH` (optional; empty = F&A LIVE defaults)
- `GHL_LOCATION_ID`, `GHL_PIPELINE_ID`
- `GHL_DRY_RUN=true`
- `ALLOW_PRODUCTION_CONTACT_WRITES=false`
- `FAKE_CONTACT_ONLY=true`
- `FORBIDDEN_MASTER_LOCATION_ID=NQwD3zdWCuBSVpOuzybj` (informational; block is hard-coded)

Owner secrets (never commit / never print):
- `GHL_API_TOKEN`
- `GHL_WEBHOOK_SECRET` (per deployment)
- `AUTH_SECRET`
- `AUTH_OWNER_EMAIL` / `AUTH_OWNER_PASSWORD`
- optional Admin/Client credentials
- optional `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`

## Auth

When `AUTH_SECRET` is set, middleware protects dashboard pages and private APIs.  
Webhooks stay machine-accessible with the deployment webhook secret.  
Roles: `OWNER` | `ADMIN` | `CLIENT` (same deployment access in V1).

## Safety

- Protected Master `NQwD3zdWCuBSVpOuzybj` is always refused
- Default dry-run / no production writes
- Vercel Deployment Protection remains the Preview access layer until auth secrets are set

## Scripts

| Command | Purpose |
|---------|---------|
| `npm test` | Unit tests |
| `npm run build` | Production build |
| `npm run check:readiness` | Config readiness |
| `npm run client:prepare` | Terminal deployment checklist |
| `npm run client:validate` | Env/config validator |
| `npm run client:generate` | Non-secret deployment manifest |

## Architecture notes

- `$297` only — see `docs/$297_FEATURE_MATRIX.md`
- Webhook security — `docs/WEBHOOK_SECURITY_V1.md`
- Auth next steps historically noted in `docs/AUTH_NEXT_GATE.md` (foundation now shipped)
