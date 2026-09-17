# Dashboard authentication — foundation + hardening

Cookie sessions with server-side session IDs (memory + optional Supabase `auth_sessions`).
Logout revokes the session record (replay denied).
Production (`VERCEL_ENV=production`) **fail-closes** if `AUTH_SECRET` is missing.
See `docs/VERCEL_RELEASE_POLICY.md`.

Owner must set:
- `AUTH_SECRET`
- `AUTH_OWNER_EMAIL` / `AUTH_OWNER_PASSWORD`
- optional Admin/Client credentials

Apply `supabase/migrations/20260917_auth_sessions.sql` manually before relying on multi-instance revocation.
Do not require HighLevel $497 OAuth for dashboard login.
