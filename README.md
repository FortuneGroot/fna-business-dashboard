# Fortune & Automations Business Dashboard

Next.js business dashboard. Native mode (`AUTH_PROVIDER=supabase`) serves many workspaces from one
deployment on Supabase Auth and Postgres with row-level security: contacts, opportunities, calendars,
tasks, internal notes, team and settings per workspace, plus a platform console for provisioning and
support. The design and navigation are unchanged from the original F&A dashboard.

Legacy mode (`AUTH_PROVIDER=legacy`, still the default until the approved cutover) keeps the original
cookie login and shows the F&A data as a read-only snapshot of the last workflow-synced activity.
Workflow (HighLevel) sync was retired in P7; history is in `docs/archive/`.

Design and phase record: `docs/NATIVE_MULTI_TENANT_SPEC.md` and `docs/NATIVE_MULTI_TENANT_CHECKLIST.md`.

## Local

```bash
cp .env.example .env.local
npm install
npm test
npm run dev
```

Open http://localhost:3000 → redirects to `/login`.

## Environment

Names only — values are owner secrets and are never committed or printed. See `.env.example`.

- `AUTH_PROVIDER` — `legacy` (default) or `supabase`
- Native mode (all server-side): `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` (or `SUPABASE_ANON_KEY`), `SUPABASE_SERVICE_ROLE_KEY`, `APP_ORIGIN`
- Legacy mode: `AUTH_SECRET`, `AUTH_OWNER_EMAIL` / `AUTH_OWNER_PASSWORD` (optional admin/client logins),
  optional `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` for the session store and the read-only snapshot

## Safety

- Production (`VERCEL_ENV=production`) fails closed when legacy auth is not configured
- Workspace isolation is enforced in Postgres (RLS); the service-role key is confined to an allowlisted server module
- No outbound email/SMS, no external CRM calls

## Scripts

| Command | Purpose |
|---------|---------|
| `npm test` | All suites via `scripts/run-tests.mjs` (fails closed; Docker-backed suites report BLOCKED when Docker is missing) |
| `npm run test:unit` / `test:db` / `test:db:concurrency` / `test:stack` | One suite |
| `npm run typecheck` | Strict TypeScript for app and tests |
| `npm run build` | Production build |
| `npm run verify:auth` | Probe a running deployment's auth behavior |
