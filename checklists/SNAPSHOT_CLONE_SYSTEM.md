# Snapshot / clone / remap system (LIVE IDs as of checkpoint 2026-09-12)

**Do not take a Snapshot yet.** Workflows are not FULL_DRAFT. This pack is remap-ready for when the live build is snapshot-able.

## Source (do not copy onto a client)

| Object | LIVE F&A value |
|---|---|
| Location | `kIXDnRuhkj6HLR1g6V6V` |
| Pipeline | `6XevPh4T3rX0qAYRfuta` Fortune & Automations Sales Pipeline |
| Funnel | `HWxh647jSR6fa06hWceA` 10 \| CORE - Lead & Booking Starter (unpublished) |
| KB | `F7VxZd9ZBrqafLKIt1Jq` AI stays OFF |
| WF 00.01 | `cf1bc310-60d9-4c1c-90a1-c5f4d418f72d` Draft |

**Never clone from** Master `NQwD3zdWCuBSVpOuzybj` or old pipeline `iYIxeKOdg5jkoAfKNnYM` or old funnel `HTqU4udPzzCzq6EIyZuI`.

## Calendar remap (LIVE API IDs)

| Live name | ID | Clone action |
|---|---|---|
| Core Booking | `F9LVww8rYXY8YNixW8oH` | New ID; reassign host; not CAL-002 |
| Discovery call | `tSKD2Zxwhbzcx21enWXj` | New ID; host |
| Website Consultation | `03JBvc6FIOt4p8mRWRtI` | New ID; host |
| Business Consultation | `m8tTKKRpbZJn43LRbW14` | New ID; do not rename to Business Systems Consultation |
| Client/Project Meeting | `k5tjoZR9zwwfmqeFYzr0` | New ID; host / round-robin if roster exists |
| Automation Consultation | NOT ON PLATFORM | Do not invent |

## Form remap

| Intended | Current list name | LIVE ID |
|---|---|---|
| 01 General Contact | Form 0 | `WYQJlUcvBCjtAQbh5y41` |
| Native Contact Us | Contact Us | `4ULhasDaYHJGE4SSptcW` — do not delete |
| 02 Quote | Form 2 | `1MEcqR1xTiYSShWrCM5D` |
| 03 Appointment Intake | Form 3 | `dvfQRpPx0hcz0yDMtGM1` |
| 05 Qualification | Form 4 | `PyF5UHJ78VZ5tPTLneqS` |
| 04 Customer Feedback | missing | create on clone if still missing |

IDs regenerate per sub-account. Rebind workflows/forms by **name**.

## Staff mapping (every clone)

- Calendar hosts
- Internal alert recipient (WF 90.01)
- Assigned users on tasks
- Conversation AI escalation (keep AI OFF until client owner says yes)

Do not invent user IDs. Session user captured on F&A 2026-09-12: `uBGzVCNYPD6t7xGdipmY` — F&A only, not a clone default.

## Custom fields / values

- Field **definitions** transfer; **IDs** regenerate. Verify each required field by name after clone.
- 32 custom values must be rewritten with the **client's** business facts. Never leave Fortune & Automations hours/address/booking URL in a client account.

## Email / domain remap

- Intended F&A app: `app.fortuneandautomations.com`
- Intended F&A links: `links.fortuneandautomations.com`
- Each clone needs its own sending domain + link domain. DNS is owner/provider — not this pack.

## Phone / A2P remap

- F&A: not purchased (zero-spend).
- Each clone: client-paid number + 10DLC. Do not share F&A's future number.

## OAuth remap

GBP / Google Calendar / Facebook / Instagram must be the **client's** accounts. Never reuse F&A OAuth.

## Pipeline / stage verification

Confirm 10 custom stage **names** + native Won/Lost. Bind by name, not index. Order may not persist.

## Post-clone validator (run on clone only)

1. Location ID ≠ `kIXDnRuhkj6HLR1g6V6V` and ≠ Master.
2. No `iYIxeKOdg5jkoAfKNnYM`.
3. No "Fortune & Automations" in client-facing custom values (except agency watermark if contracted).
4. All workflows Draft/OFF.
5. Conversation AI OFF. Voice AI unassigned.
6. Reputation auto-send OFF until client review workflow is the sole sender.
7. Fake contact `@example.invalid` only for tests; delete before client handoff.

## Recovered operating procedure (still valid)

The Sep 12 Cursor work package `CLIENT_CLONE_AUTOMATION_PLAN.md` is the target clone SOP after Snapshot exists. Copy lives at `fna-app/recovered/CLIENT_CLONE_AUTOMATION_PLAN.md`.

That plan assumed Master Core as the snapshot source. **Live evidence now wins:** do not snapshot Master `NQwD3zdWCuBSVpOuzybj`. Snapshot source, when ready, is LIVE location `kIXDnRuhkj6HLR1g6V6V` after workflows are FULL_DRAFT. The remap/safety table above still applies.

Do not clone into a paying client until `PRE_ACTIVATION_GATE` is signed. Keep a separate client `.env` — never point the Master/LIVE token at a client location by accident.

