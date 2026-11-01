# Archived: single-tenant GHL era (retired in P7)

These documents describe the pre-native dashboard: one client per deployment, data synced from HighLevel
workflow webhooks into `sync_*` tables, and per-client JSON configuration. P7 removed that runtime
(see `docs/NATIVE_MULTI_TENANT_SPEC.md` §21). The documents are kept for history only; the commands,
routes, and settings they mention no longer exist in this branch.

| Document | What it described |
|---|---|
| `GHL_SYNC_WEBHOOK_CONTRACT.md`, `GHL_WORKFLOW_SYNC_MAP.md`, `WEBHOOK_SECURITY_V1.md` | `/api/webhooks/ghl` ingestion contract, workflow map, signature rules |
| `CLIENT_DEPLOYMENT_RUNBOOK.md`, `CLIENT_CLONE_MANIFEST.md`, `CLIENT_GO_LIVE_GATE.md` | per-client deployment with `client:prepare`, `CLIENT_CONFIG_PATH`, readiness gate |
| `CLIENT_ONBOARDING_CHECKLIST.md`, `FAST_CLIENT_ONBOARDING.md`, `FIRST_FAKE_CLIENT_E2E.md` | onboarding a client sub-account and its webhooks |
| `TENANT_CONTENT_AUDIT.md`, `$297_FEATURE_MATRIX.md`, `297_FEATURE_MATRIX.md` | F&A default-config content audit and HighLevel plan feature limits |
| `checklists/SNAPSHOT_CLONE_SYSTEM.md`, `checklists/POST_CLONE_VALIDATOR.md`, `checklists/WEBSITE_GHL_INTEGRATION.md` | HighLevel snapshot cloning, post-clone checks, website-to-HighLevel lead flow |

## Recovering the GHL runtime

Nothing was destroyed. To restore live webhook sync, deploy a pre-P7 build — the `release` branch
(`9c189f8`) or any commit up to `619a558` on `feat/native-multi-tenant` — or `git revert` the P7 commit.
The `sync_*` tables, their migration, and the data in them were not touched.
