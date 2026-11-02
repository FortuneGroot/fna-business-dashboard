# Legacy migration version mapping

The two legacy migrations used the same 8-digit prefix, which the Supabase CLI reads as a single
version (`20260917`). They now have unique 14-digit versions. File contents are byte-for-byte
unchanged; only the filenames changed (`git mv`).

| Old file | New file | Version | Basis |
| --- | --- | --- | --- |
| `20260917_sync_store.sql` | `20260917121316_sync_store.sql` | `20260917121316` | First commit `c74f36a`, 2026-09-17 08:13:16 -04:00 = 12:13:16 UTC |
| `20260917_auth_sessions.sql` | `20260917185155_auth_sessions.sql` | `20260917185155` | First commit `7968520`, 2026-09-17 14:51:55 -04:00 = 18:51:55 UTC |

Both sort before the native multi-tenant migrations (`20261101000100` … `20261101002500`). The two
legacy files create independent tables (`sync_*` and `auth_sessions`), so their relative order has
no functional effect; it follows commit order. `tests/db/migrations.test.ts` enforces unique,
ordered 14-digit versions.

## Applied-history evidence (no production access was used)

- Both files carry "apply manually" / "do not run against production unless owner-authorized"
  headers, and `docs/AUTH_NEXT_GATE.md` says to apply `auth_sessions` manually.
- The repository had no `supabase/config.toml`, no linked project ref, and no record of
  `supabase db push` or `supabase migration repair`.
- Conclusion: **any existing database's history is unknown.** If the SQL was run by hand (SQL
  editor), `supabase_migrations.schema_migrations` probably has no rows for these files; if it was
  ever pushed with the CLI, it may contain a row with version `20260917`.

## Cutover prerequisite: reconcile history (do not repair blindly)

Run against the separate staging project first (D4), and against production only with George's
explicit approval at cutover:

1. `supabase migration list` and inspect `supabase_migrations.schema_migrations` (read only).
2. Confirm the legacy tables exist and match these files (`\d public.sync_*`, `\d public.auth_sessions`).
3. Decide per finding, and record the decision:
   - Row `20260917` present → `supabase migration repair --status reverted 20260917`, then
     `supabase migration repair --status applied 20260917121316 20260917185155`.
   - No rows, tables present (applied by hand) →
     `supabase migration repair --status applied 20260917121316 20260917185155`.
   - Tables absent → let `supabase db push` apply both files normally.
4. Re-run `supabase migration list`; local and remote must match before `db push` of the required manifest (`docs/STAGING_CUTOVER_CHECKLIST.md` §5: M1–M14 and M16–M26; never the deferred, destructive M15).
