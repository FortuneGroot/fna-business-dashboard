# CLIENT-READY CRITICAL QA

The 26 checks that must pass before a demo or clone. **The full 48 QA + 52 Red Team
are NOT removed** — they remain required for final certification. This is the fast
gate. All checks are no-send / config-only. Unknown = FAIL.

| # | Check | Pass means | Maps to |
|---|---|---|---|
| 1 | Lead enters via form | one contact created, no duplicate | QA-01, QA-03 |
| 2 | Opportunity created | one opportunity in stage `01 New Lead`, Open | QA-05 |
| 3 | Pipeline correct | single pipeline `F&A MASTER \| LEAD & SALES PIPELINE`, stages 01–09 + 12, native Won/Lost | QA-08 |
| 4 | No backward stage move | intake/reply never overwrites a terminal status | RT / recipe rule |
| 5 | Form works (all 5) | submit at mobile width, clear success message | QA-01 |
| 6 | Consent unchecked → no SMS | inquiry saved, zero SMS queued | QA-01, RT-consent |
| 7 | STOP / DND honoured | after STOP, no further sends in any workflow | QA-14, RT |
| 8 | Booking works | calendar slot → appointment created, one confirmation owner | QA appt |
| 9 | Reminder single owner | native reminder OR WF 30.02, never both | G7, RT-027 |
| 10 | Missed-call single owner | native text-back OR WF 20.02, never both | G7, RT-033 |
| 11 | Review request single owner | Reputation module OR WF 60.01, never both | G7, RT-034 |
| 12 | No duplicate acknowledgement | form + chat same minute → one opportunity, one reply | RT-001 |
| 13 | Human takeover | `human-required` tag suppresses automation until cleared | QA, WF 90.02 |
| 14 | AI disable per contact | `do-not-automate` → sends suppressed, Conversation AI set Off | WF 00.01 |
| 15 | Global kill-switch | WF 00.01 present, public trigger bound (tag + DND) | WF 00.01 |
| 16 | Won path | Won status → thank-you path only, no lost path | QA, WF 40.04 |
| 17 | Lost path | Lost status → lost path only, lost reason captured | QA, WF 40.05 |
| 18 | Follow-up logic | no-response nurture respects frequency cap, ends cleanly | QA, WF 20.04 |
| 19 | Reactivation gated | needs approved cohort + evidence + throttle before it can run | QA, WF 70.01 |
| 20 | Review flow | feedback captured, no score gate, low score → staff task | QA-02 |
| 21 | Unified inbox | SMS/email/FB/IG/GBP/chat all land in Conversations | inbox setup |
| 22 | Internal alerts | notification action present in source workflow, recipient shown unset | alerts |
| 23 | AI OFF state | Conversation AI mode = off, Voice AI unassigned, no autonomous replies | QA-29/32 |
| 24 | No accidental sends | nothing published, enrollment 0, no test sends fired | activation gate |
| 25 | Dashboards render | both dashboards show native widgets, real sources, no fake data, F&A colours | dashboard plan |
| 26 | White-label presentation | client login = F&A branding, no HighLevel/LeadConnector strings, links on `links.` | white-label |

## Run order
1–5 (data path) → 6–7 (consent/DND) → 8–11 (single-owner) → 12–15 (dedupe/takeover/kill) →
16–20 (lifecycle) → 21–24 (ops/AI/safety) → 25–26 (presentation).

## After this passes
Run the full `QA_48_EXECUTION_MANIFEST.json` (48/48) and `RED_TEAM_52_EXECUTION_MANIFEST.json`
(52/52) for certification before any client go-live.
