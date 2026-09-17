# Static 316-object audit note

The historical **316** lock (`CANONICAL_316_LIVE_STATUS.md`) is a **Master-era** snapshot. It is not proof that 316/316 objects exist on LIVE Fortune & Automations `kIXDnRuhkj6HLR1g6V6V`.

This tracker uses recovered LIVE checkpoint counts (2026-09-12). **No live GET this session. No case marked PASS.**

| Family | LIVE checkpoint | Notes |
|---|---|---|
| Custom values | 32 | Verified earlier, not re-GETed |
| Tags | 32 F&A + native | Count only |
| Custom fields | 27 created IDs in crosswalk | Do not recreate |
| Pipeline | 1 (`6XevPh4T3rX0qAYRfuta`) | 10 custom stages + native Won/Lost |
| Calendars | 5 | Automation Consultation absent |
| Forms | 5 shells | FORM-004 dedicated feedback missing; names still Form 0/2/3/4 |
| Funnel | 1 unpublished `HWxh647jSR6fa06hWceA` | 5 steps |
| Email templates | 0 live | 9 bodies local |
| SMS templates | 0 live | 21 bodies local; no phone |
| Workflows | 1 draft (00.01) | 44 not constructed — out of scope this pass |
| Knowledge | 1 draft KB + 11 FAQs | AI OFF; KB-11 empty |
| Dashboards | Native GHL widgets | This app is a separate branded shell |

Run `python qa/run_static_audit.py` to refresh detectors.
