# Vercel release policy

## Risk
`main` must not silently ship unauthenticated Production if `AUTH_SECRET` is missing.
Code now **fail-closes** when `VERCEL_ENV=production` and `AUTH_SECRET` is absent.

## Recommended model (OWNER ACTION — do not auto-change Vercel)

### Option A — protected release branch (preferred)
1. Keep `main` as integration / Preview.
2. Create a protected branch (e.g. `release` or `production`).
3. Point the Vercel **Production** branch to that protected branch only.
4. Require PR review + green CI before merge to the release branch.
5. Preview deployments continue from `main`.

### Option B — Ignored Build Step on Production
If Production must track `main` temporarily:
1. In Vercel → Project → Settings → Git → Ignored Build Step
2. Use a script that skips Production builds unless `AUTH_SECRET` is present and an explicit `ALLOW_PRODUCTION_BUILD=true` is set for that deploy.
3. Owner must configure this in the Vercel UI — this repo does not change Vercel settings automatically.

## Production readiness checklist (owner)
- [ ] `AUTH_SECRET` set in Production env
- [ ] `AUTH_OWNER_EMAIL` / `AUTH_OWNER_PASSWORD` set
- [ ] `GHL_WEBHOOK_SECRET` set (per deployment)
- [ ] `GHL_LOCATION_ID` matches `CLIENT_CONFIG_PATH` location
- [ ] `ALLOW_PRODUCTION_CONTACT_WRITES=false` until explicitly authorized
- [ ] Master location never configured
- [ ] Vercel Deployment Protection reviewed alongside app auth

## Code behavior reminder
| Environment | No `AUTH_SECRET` |
|-------------|------------------|
| Local / Preview | Open unless `AUTH_FAIL_CLOSED=true` (Vercel Protection still recommended) |
| Production (`VERCEL_ENV=production`) | **Fail closed** — protected routes return 503 / login misconfigured |

No Production deployment is considered ready until auth is configured.
