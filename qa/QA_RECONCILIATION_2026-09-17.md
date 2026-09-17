# QA / Red Team reconciliation — 2026-09-17

Source of truth for live non-workflow + workflow ownership: `../current state 9-17.md`.

## Policy
- Mark PASS only with live evidence.
- Do **not** mark workflow cases PASS unless Grok verified them.
- Do **not** invent owner values or CRM writes.

## Trackers
- QA48: `fna-app/qa/qa_48_tracker.csv` — all rows remain `NOT RUN IN HIGHLEVEL` (no false PASSes added).
- Red Team 52: `fna-app/qa/red_team_52_tracker.json` — all cases remain `NOT_RUN` (no false PASSes added).

## Non-workflow facts verified live (supporting evidence only — not QA48 row PASSes)
| Fact | Status |
|---|---|
| Reviews AI OFF | VERIFIED live |
| KB 12/12 (Escalation Rules empty shell) | VERIFIED live |
| KB-08 Core Booking wording | VERIFIED live |
| 29 canonical tags present | VERIFIED live |
| Legal Business Name = Fortune & Finance LLC | VERIFIED live |
| Custom Values 32/32 keys exist | VERIFIED live |
| SMS 21/21 / Email snippets 9/9 | VERIFIED prior non-workflow run |
| Sales Efficiency pipeline bind | OPEN |
| Opportunity Sales Notes field | OPEN / UI blocked |
| Forms rename + FORM-004 | OPEN / other lane |
| Calendars notification/staff | OPEN / other lane |
| Owner emails + Logo/Booking/Reschedule/Review/ZIP | OWNER VALUE REQUIRED |

## Workflow facts (Grok lane — do not PASS here)
| Fact | Status |
|---|---|
| ~9/45 Batch 1 built | Grok-reported; 1 verified + 8 partial |
| Batch 2 | in progress |
| WF10.03 title/Save | blocker |
| Batch 1 bindings incomplete | blocker |
| possible duplicate WF10.04 | review only — do not delete |
