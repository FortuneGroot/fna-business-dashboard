# LIVE DASHBOARD SPEC — Fortune & Automations Business Dashboard

Location: `kIXDnRuhkj6HLR1g6V6V` · Native HighLevel widgets only. No custom-report iframe (confirmed PLATFORM_DEFECT per `CANONICAL_316_LIVE_STATUS.md` / `nightly/OVERNIGHT_FINAL_HANDOFF.md` — the 2 reporting-dashboard shells render an empty iframe). This spec governs the two dashboards that DO work natively: the renamed location dashboard ("Fortune & Automations Business Dashboard") and the Sales dashboard.

## Status legend
- **LIVE_VERIFIED** — confirmed live + persisted after reload per `CANONICAL_316_LIVE_STATUS.md` §Dashboards.
- **NEEDED_NATIVE** — native widget exists in HighLevel's widget catalog, not yet added.
- **NOT_NATIVE** — no native widget provides this; do not fabricate a custom metric for it (see `metrics.csv`: most metrics are `NO DATA / NOT CONNECTED`).

## Dashboard 1 — "Fortune & Automations Business Dashboard" (default location dashboard, `/dashboard/6aa053214868d0b5cf909563`)

| Priority metric | Native widget | Status | Notes |
|---|---|---|---|
| New Leads | Contacts count (filtered to new) | LIVE_VERIFIED (Contacts count widget already live) | Confirm filter scoped to "new" date range, not all-time total |
| Open Opportunities | Opportunity counts by status | LIVE_VERIFIED | Already live per canonical status |
| Pipeline Value | Opened Opportunity value | LIVE_VERIFIED | Already live |
| Won Revenue | Won Opportunities value (this month) | NEEDED_NATIVE on this dashboard (lives on Sales dashboard today) | Consider duplicating widget here for single-pane owner view |
| Conversion Rate | — | NOT_NATIVE | No native lead→won conversion widget confirmed; `metrics.csv` marks conversion rates `NO DATA / NOT CONNECTED`. Do not add a fabricated tile. |
| Appointments | Appointment count widget | LIVE_VERIFIED | Added tonight per canonical status, themed F&A colors |
| Upcoming Appointments | Upcoming appointments (next week) | LIVE_VERIFIED | Already live |
| Missed Appointments | No-show / missed filter on appointment widget | NEEDED_NATIVE | Check widget catalog for a "No-show" native filter before building a workaround |
| Unread Conversations | — | NOT_NATIVE on dashboard (available in Conversations inbox itself, "Unread" tab, not as a dashboard tile) | Do not force it onto the dashboard; reference inbox instead |
| Lead Sources | Native source report widget, if available in catalog | NEEDED_NATIVE — verify existence | `metrics.csv` shows "Leads by source" as NO DATA / NOT CONNECTED; only add if a true native widget exists, else omit |
| Follow-Ups | Tasks widget scoped to follow-up type | NEEDED_NATIVE | Depends on task-type tagging discipline |
| Tasks | Tasks due / overdue widget | NEEDED_NATIVE | |
| Reviews | Reputation summary widget | NEEDED_NATIVE — blocked until GBP OAuth (OWNER_LOGIN_REQUIRED) | No reviews exist until Reputation is connected |
| Won Deals | Won Opportunities count | LIVE on Sales dashboard | See Dashboard 2 |
| Lost Deals | Lost Opportunities count | LIVE on Sales dashboard | See Dashboard 2 |
| Recent Opportunities | Opportunities list/recent-activity widget | NEEDED_NATIVE | |
| Sales Performance | Opportunity revenue over time | LIVE on Sales dashboard | See Dashboard 2 |

## Dashboard 2 — "Sales" (`/dashboard/6aa053444fdb362eee98c44b`)

| Metric | Status |
|---|---|
| Opened Opportunities | LIVE_VERIFIED |
| Won Opportunities | LIVE_VERIFIED |
| Lost Opportunities | LIVE_VERIFIED |
| Opportunity revenue over time | LIVE_VERIFIED |
| Won Opportunities value this month | LIVE_VERIFIED |

All native Won/Lost widgets use HighLevel's built-in Won/Lost stages, not the 10 custom pipeline stages — matches canonical decision "native Won/Lost (no custom stages)" and avoids double-counting.

## Branding
Apply F&A palette where the widget theme picker allows: Primary Navy `#17324F`, Secondary Navy `#10263B`, Dark Navy `#0A1827`, Gold `#C7A16A`, Cream `#F2EDE5`. The Appointment count widget is already themed this way (confirmed live). Extend the same theme to any newly added widget. Do not invent a "brand mode" beyond what HighLevel's dashboard/widget settings expose.

## Explicit non-invention rule
Every row above marked NOT_NATIVE stays NOT_NATIVE until Cursor confirms a genuine native widget in the live HighLevel widget picker. Do not build a custom-report workaround given the confirmed reporting-dashboard iframe defect — log any such attempt as PLATFORM_DEFECT, not as a completed row.
