# Per-client webhook security (V1)

## Model
ONE CLIENT = ONE DASHBOARD DEPLOYMENT = ONE `GHL_WEBHOOK_SECRET` in that deployment’s env.

## Rules
- Secret is server-side only (`process.env.GHL_WEBHOOK_SECRET`).
- Never store the secret in GHL Custom Values.
- Never expose to the browser or `NEXT_PUBLIC_*`.
- Never print secret values in logs, readiness, or manifests.
- Readiness / validators report **PRESENT** or **MISSING** only.
- Ingestion validates:
  1. webhook secret (when configured / enforced)
  2. configured client location ID
  3. absolute Master block (`NQwD3zdWCuBSVpOuzybj`) — not overridable

## Headers
Workflows should send the deployment secret in:
- `x-webhook-secret`, or
- `x-ghl-signature` (treated as shared-secret equality for V1)

## Future (not V1)
A shared multi-client secret database / agency-wide router is deferred. Do not build it until multi-tenant routing is an intentional product decision.
