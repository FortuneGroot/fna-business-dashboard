# CLIENT CLONE AUTOMATION PLAN

Future process after the Master Snapshot exists and the fake-client clone has passed.

**Today:** Master does not exist in HighLevel. This is the target operating procedure — not a claim that it already runs.

Do not clone into a live paying client until `PRE_ACTIVATION_GATE.md` is signed.

## Ideal flow

```text
New client sold
  → collect CLIENT_CONFIGURATION_TEMPLATE (clock does not start)
  → create blank sub-account (client name — not the Master name)
  → apply Master Snapshot F&A MASTER CORE - v1.0
  → inject client Custom Values from mapping sheet
  → map users / roles
  → connect client-owned phone + email domain (not F&A agency numbers)
  → configure calendars + hours
  → leave all activation rows OFF
  → remap form IDs, template picker keys, pipeline stage IDs
  → no-send test lead
  → owner signs PRE_ACTIVATION_GATE
  → enable only requested modules
  → launch
```

## Step classification

| Step | Class | Why |
|---|---|---|
| Collect client facts / consent / hours / services | **REQUIRES CLIENT DECISION** | Cannot invent. Template: `MAPPING_PACK/client_configuration_values.csv`. |
| Create blank sub-account | **MANUAL** / later **AUTOMATABLE LATER** | Agency UI today. Agency API for sub-account create is not used in this provisioner (wrong blast radius). |
| Apply Master Snapshot | **MANUAL** / **REQUIRES GHL LIMITATION** | Agency Snapshots UI. Not the Git repo. Load only into blank destination. |
| Inject Custom Values | **AUTOMATABLE NOW** (after token on **that** location) | Same `apply`/`PUT` path — **only** if location name is the **client** account you intend, token scoped there, and values are from the signed template. **Do not point the Master `.env` at a live client by mistake.** Prefer a separate client `.env`. |
| Copy field/tag/pipeline structure | **AUTOMATABLE LATER** / Snapshot | Snapshot should carry them; still **VERIFY**. Re-apply only if clone missed objects. |
| Map users | **MANUAL** | Users do not transfer. `MAPPING_PACK/staff_user_mapping.csv`. |
| Map phone / A2P | **REQUIRES CLIENT DECISION** + **REQUIRES GHL LIMITATION** | Client-owned number. Payment/Trust Center. Forbidden on Master. |
| Map email / DNS | **REQUIRES CLIENT DECISION** | Out of this repo. Domain verification is not in the provisioner. |
| Configure calendars | **MANUAL** then **AUTOMATABLE LATER** | Staff IDs + hours. API possible after real IDs. |
| Remap form IDs in workflows | **MANUAL** / **REQUIRES GHL LIMITATION** | Triggers store IDs. `form_id_capture.csv`. |
| Remap CV picker keys in templates | **MANUAL** | Keys differ per location. |
| Keep modules OFF | **AUTOMATABLE NOW** as policy | Do not publish. Gate file. |
| Activate chosen modules | **REQUIRES CLIENT DECISION** + owner sign-off | `PRE_ACTIVATION_GATE.md`. One module at a time. |
| Test lead | **MANUAL** | Fake data only first. `FAKE_CLIENT_DRY_RUN.md`. |
| Launch | **MANUAL** | Owner. |
| CRM / Stripe / Google / Meta | **REQUIRES CLIENT DECISION** | Credentials never in Snapshot. |
| Industry adapters 95.01–95.07 | **REQUIRES CLIENT DECISION** | Off unless selected. |
| Conversation / Voice AI On | **REQUIRES CLIENT DECISION** | Approved KB; Off until then. |

## Safety rule for any future “inject values” script

1. Retrieve location.  
2. Name must **not** contain `F&A MASTER CORE` if you are writing **client** facts (Master stays placeholders).  
3. Name must **not** be a production client until the gate passes.  
4. `ALLOW_GHL_WRITES` default false.  
5. No sends. No DELETE.

The current provisioner **refuses writes** unless the location name contains `F&A MASTER CORE` and `DO NOT USE LIVE`. That is correct for **Master** apply. A future client injector needs a **separate** safety profile (client location allowlist). Do not weaken the Master gate to write client accounts.

## What Snapshot is for

Reusable **structure**: fields, tags, pipeline, Draft workflows, unpublished forms/pages, template shells, inactive calendars.

Not: users, numbers, domains, OAuth, Stripe, runtime contacts, approved knowledge, live AI, live workflows.
