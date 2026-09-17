# INTERNAL — F&A ONLY

# F&A Master Client Delivery Runbook
**File:** `00-FA-MASTER-CLIENT-DELIVERY-RUNBOOK.md`  
**Purpose:** One scan → Where am I? What’s next? Which tool/doc? What’s blocking?  
**Rule:** Point to existing systems. Do not rebuild them here.

SIGNED → LIVE SITE → LIVE GHL → TRAINED CLIENT → CARE or HANDOFF

---

## How to use this (30 seconds)

1. Open the **One-Page Project Dashboard** (end of this file) for the client.  
2. Match **STATUS** → **Stage** below.  
3. Do **ACTIONS** → produce **REQUIRED OUTPUT** → clear **GO CONDITION**.  
4. Open the **SOURCE DOCUMENT** only when you need the checklist/detail.  
5. Escalate per **Escalation Rules** / **Do Not Do This**.

---

## Bot lanes (permanent)

| Bot | Owns | Does not own |
|---|---|---|
| **ATLAS / ChatGPT** | PM · architecture decisions · audit outputs · resolve bot conflicts · final recommendation · cross-system reasoning | Day-to-day repo coding; silent architecture changes |
| **Cursor** | Repo implementation · code · integration · validation · tests · fix · deploy prep | Rewriting agency policy packs; inventing client facts |
| **Gemini Pro** | Independent infra/research audit · industry/SEO/local validation · architecture red-team · compliance/factual-risk audit | Becoming second implementer unless asked to audit |
| **Grok Bot** | Structured agency docs · industry ops packs · client-facing guides · sales/marketing operating assets | Production code in the starter repo |

**No duplicate work** unless explicitly an independent audit.

---

## Document map (open these — don’t copy them)

| System | Use for |
|---|---|
| Client Input System | Intake, facts sheet, research, competitors, page decisions |
| Client Build Brief | Single handoff to builders |
| Roofing / HVAC Industry Packs | Defaults by vertical |
| Universal Website Starter | Codebase / clone for sites |
| Universal GHL Master | Clone/configure CRM |
| Agency Ops Pack (01–08) | Onboarding, revisions, approval, launch, care, GHL activation, offboarding, training |
| Content Deadline Policy (09) | Late assets, dormant, restart fees |
| Website Approval / Launch Handoff / Monthly Care / Offboarding | As named |

---

# Eight delivery stages

## Stage 1 — SOLD
| | |
|---|---|
| **INPUT** | Signed deal, package chosen |
| **OWNER** | F&A owner / sales |
| **TOOLS** | Contract, invoice, CRM |
| **SOURCE DOCUMENT** | Agency Ops → Onboarding (Gate 0 commercial) |
| **ACTIONS** | Collect signature · take deposit · confirm package (5/7-page) · create client folder · set STATUS=`WAITING PAYMENT` then `WAITING CLIENT` when paid |
| **AUTOMATION OPPORTUNITY** | Payment webhook → create folder + onboarding email |
| **REQUIRED OUTPUT** | Signed SOW + payment record + `/clients/[slug]/` skeleton |
| **STOP/BLOCK** | No signature; payment failed |
| **GO CONDITION** | Deposit cleared (or written exception) |
| **NEXT STAGE** | 2 — Onboarding |
| **STATUS** | `WAITING PAYMENT` → after pay: `WAITING CLIENT` |

---

## Stage 2 — ONBOARDING
| | |
|---|---|
| **INPUT** | Paid client folder |
| **OWNER** | F&A PM (Atlas advises) |
| **TOOLS** | Email/SMS, intake form, GHL |
| **SOURCE DOCUMENT** | Ops Onboarding · Content Deadline Policy · Training not yet |
| **ACTIONS** | Send intake + asset list + content deadline · request domain/GBP access path · schedule kickoff · explain revisions/approval |
| **AUTOMATION OPPORTUNITY** | Auto-send onboarding pack on payment |
| **REQUIRED OUTPUT** | Intake sent; deadline date on dashboard; contacts logged |
| **STOP/BLOCK** | No client contact path |
| **GO CONDITION** | Client acknowledged kickoff / intake in flight |
| **NEXT STAGE** | 3 — Facts / Assets |
| **STATUS** | `WAITING CLIENT` |

---

## Stage 3 — FACTS / ASSETS
| | |
|---|---|
| **INPUT** | Partial/complete intake + uploads |
| **OWNER** | F&A PM · research assist (Gemini audit if needed) |
| **TOOLS** | Intake answers, Drive/folder, GBP |
| **SOURCE DOCUMENT** | Client Input System (intake, verified facts, research, assets) · Industry Pack · Content Deadline Policy |
| **ACTIONS** | Collect assets · fill Verified Facts · light research · chase overdue per policy · mark draft vs verified |
| **AUTOMATION OPPORTUNITY** | Reminder sequence on overdue content |
| **REQUIRED OUTPUT** | Facts sheet started; asset checklist updated; blockers listed |
| **STOP/BLOCK** | Critical contact/NAP missing with no placeholder plan; invented-fact pressure |
| **GO CONDITION** | Enough to write Build Brief (placeholders OK; no fake facts) |
| **NEXT STAGE** | 4 — Build Brief |
| **STATUS** | `WAITING CLIENT` or `READY FOR BUILD` when briefable |

---

## Stage 4 — BUILD BRIEF
| | |
|---|---|
| **INPUT** | Intake + facts + industry defaults |
| **OWNER** | Atlas (structure) · Grok (packaging if needed) · PM signs off |
| **TOOLS** | Industry Pack, Input System templates |
| **SOURCE DOCUMENT** | Client Build Brief · Industry Pack · Input System page/CTA frameworks |
| **ACTIONS** | Select industry pack · lock 5/7 pages · CTAs · homepage order · GHL notes · do-not-invent list · set STATUS=`READY FOR BUILD` |
| **AUTOMATION OPPORTUNITY** | Generate brief draft from intake form fields |
| **REQUIRED OUTPUT** | Completed **F&A CLIENT BUILD BRIEF** in `04_Build_Brief/` |
| **STOP/BLOCK** | Conflicting scope; missing industry choice for nonstandard niche |
| **GO CONDITION** | Brief marked READY FOR BUILD |
| **NEXT STAGE** | 5 — Website Build |
| **STATUS** | `READY FOR BUILD` → `BUILDING` |

---

## Stage 5 — WEBSITE BUILD
| | |
|---|---|
| **INPUT** | Build Brief + assets |
| **OWNER** | **Cursor** implements · Atlas audits · Gemini red-teams if architecture risk |
| **TOOLS** | Universal Website Starter, builder stack, Design preview |
| **SOURCE DOCUMENT** | Build Brief · Website Starter · Ops Revisions · Approval |
| **ACTIONS** | Clone starter (**do not fork master casually**) · apply brief · customize · internal preview · revision rounds per policy |
| **AUTOMATION OPPORTUNITY** | Scaffold site from brief JSON later |
| **REQUIRED OUTPUT** | Preview URL; revision log; no contamination of master starter |
| **STOP/BLOCK** | Scope creep without change order; client editing master; missing approval to proceed redesign |
| **GO CONDITION** | Design/content ready for client review |
| **NEXT STAGE** | 6 — GHL + QA (can overlap late Stage 5) |
| **STATUS** | `BUILDING` → `CLIENT REVIEW` / `REVISION` |

---

## Stage 6 — GHL CONNECTION + QA
| | |
|---|---|
| **INPUT** | Preview site + brief GHL section |
| **OWNER** | Cursor/GHL operator · Atlas confirms lead path |
| **TOOLS** | Universal GHL Master, sub-account |
| **SOURCE DOCUMENT** | GHL Activation · GHL Master · Industry pack automations |
| **ACTIONS** | Clone/configure sub-account · forms/pipeline/alerts · wire site · test submit · missed-call/review/AI only if in scope · mobile/CTA/NAP/SEO basics QA |
| **AUTOMATION OPPORTUNITY** | Snapshot “standard roofing/HVAC” GHL recipes |
| **REQUIRED OUTPUT** | Test opportunity in correct pipeline; notification received by human |
| **STOP/BLOCK** | Forms fail; no human alert; untested workflow pushed live |
| **GO CONDITION** | Staging lead path green |
| **NEXT STAGE** | 7 — Approval + Launch |
| **STATUS** | `GHL SETUP` / `QA` |

---

## Stage 7 — APPROVAL + LAUNCH
| | |
|---|---|
| **INPUT** | QA-green preview |
| **OWNER** | PM + client · Cursor for DNS/cutover |
| **TOOLS** | Preview, DNS/registrar, GBP |
| **SOURCE DOCUMENT** | Website Approval · Launch Handoff · Content Deadline (if stalled) |
| **ACTIONS** | Collect design/content/launch approvals · DNS · SSL · live form test · GBP link · STATUS=`LAUNCHING`→`LIVE` |
| **AUTOMATION OPPORTUNITY** | Launch checklist bot + live form ping |
| **REQUIRED OUTPUT** | Written launch approval; live URL; live lead test logged |
| **STOP/BLOCK** | No launch approval; DNS ownership unclear; factual claims unverified on page |
| **GO CONDITION** | Live lead test passed |
| **NEXT STAGE** | 8 — Training + Care / Handoff |
| **STATUS** | `APPROVED` → `LAUNCHING` → `LIVE` |

---

## Stage 8 — TRAINING + CARE / HANDOFF
| | |
|---|---|
| **INPUT** | Live site + live GHL |
| **OWNER** | Trainer (F&A) · client |
| **TOOLS** | GHL app, Training doc |
| **SOURCE DOCUMENT** | Client Training Handoff · Monthly Care · Offboarding (if ending) |
| **ACTIONS** | 15–30 min training (or 5-min emergency) · send quick-start · enroll care plan **or** schedule handoff · confirmation checklist signed |
| **AUTOMATION OPPORTUNITY** | Auto-email Section B quick-start after training |
| **REQUIRED OUTPUT** | Training confirmation; care = `CARE` or exit path documented |
| **STOP/BLOCK** | Client cannot see leads; notifications broken |
| **GO CONDITION** | Confirmation checklist complete |
| **NEXT STAGE** | Monthly Care loop **or** Offboarding when relationship ends |
| **STATUS** | `TRAINING` → `CARE` or later `OFFBOARDED` |

---

# F&A FAST PATH — Standard 5–7 page client

Shortest **safe** path:

1. Contract + payment → folder  
2. Intake + assets (+ content deadline)  
3. Select Industry Pack  
4. Generate Build Brief  
5. Clone/configure GHL sub-account  
6. Initialize Website Starter from brief  
7. Customize (AI + human)  
8. QA (site + forms + mobile)  
9. Client approval  
10. Domain launch  
11. Live lead test  
12. Training → Care or handoff  

**Skip only if risky:** launching without live form test, training, or approval.

### Duplication → automate later
| Manual today | Automate |
|---|---|
| Onboarding email + reminders | Payment-triggered sequences |
| Brief assembly from intake | Form → brief draft |
| GHL checklist per vertical | Snapshot recipes (Roofing/HVAC) |
| Status hunting across chats | Single dashboard doc/row |
| Training quick-start send | Auto-attach after Stage 8 |

---

# Status system

| STATUS | Means | Typical stage |
|---|---|---|
| `WAITING PAYMENT` | Signed, unpaid | 1 |
| `WAITING CLIENT` | Need intake/assets/feedback | 2–3, review waits |
| `READY FOR BUILD` | Brief ready | 4 done |
| `BUILDING` | Site in progress | 5 |
| `CLIENT REVIEW` | Preview with client | 5–7 |
| `REVISION` | In a counted revision round | 5 |
| `GHL SETUP` | CRM/config | 6 |
| `QA` | Testing before approval | 6–7 |
| `APPROVED` | Launch approval received | 7 |
| `LAUNCHING` | DNS/cutover in progress | 7 |
| `LIVE` | Production up; lead test done | 7–8 |
| `TRAINING` | Training scheduled/done pending confirm | 8 |
| `CARE` | Monthly care active | 8+ |
| `OFFBOARDED` | Access transferred/removed | End |
| `BLOCKED` | Hard stop (see blocker field) | Any |

**Change status only when the stage GO CONDITION is met** (or when explicitly blocked/dormant per Content Deadline Policy).

---

# Single client folder standard

```
/clients/[slug]/
  00_Admin/          # contract, invoices, dashboard.md
  01_Intake/         # questionnaire answers
  02_Brand_Assets/   # logo, fonts, colors
  03_Photos/
  04_Build_Brief/    # F&A CLIENT BUILD BRIEF
  05_Website/        # notes, preview links (code lives in starter repo)
  06_GHL/            # sub-account notes, form IDs
  07_Approvals/      # written approvals
  08_Launch/         # DNS, go-live log, live lead test
  09_Training/       # confirmation checklist
  10_Exports/        # offboarding exports
```

No extra folders unless a real artifact needs one.

---

# Escalation rules

| Situation | Do |
|---|---|
| Missing factual claim | **Never guess** — omit; Verified Facts |
| Missing asset | Content Deadline Policy |
| New page / redesign after lock | Revisions / change order |
| GHL workflow change | Test in sub-account before production |
| Domain change | Written approval |
| Out of scope ask | Quote / change order — no silent free work |
| Automation failure | Human fallback + fix |
| AI uncertainty | Human review (Atlas) |
| Bot conflict | Atlas decides |

---

# Do not do this

- Rebuild from scratch when a master/starter exists  
- Invent client facts  
- Modify live GHL without testing  
- Launch without approval  
- Store passwords in project docs  
- Buy client domains in F&A’s name by default  
- Let AI silently change architecture  
- Let client edits contaminate the master starter  

---

# Automation roadmap

### Automate now
- Onboarding email + content-deadline reminders  
- Dashboard status field discipline (even if manual)  
- Live form test checklist ping at launch  

### Stay manual
- Factual verification · scope/change orders · architecture decisions · training judgment · offboarding access removal  

### After ~10 clients
- Intake → Build Brief draft  
- Vertical GHL snapshots (Roofing/HVAC)  
- Starter scaffold from brief  
- Payment → folder creation  

### Not yet
- Fully autonomous launch  
- Auto domain purchase/DNS without human  
- AI changing master starter  
- Unsupervised live workflow edits  

---

# ONE-PAGE PROJECT DASHBOARD (blank)

```
CLIENT:
INDUSTRY:                 PACKAGE: 5 / 7 / custom
DOMAIN:
STATUS:                   PAYMENT STATUS:

INTAKE:        [ ] not sent  [ ] sent  [ ] complete
ASSETS:        [ ] missing critical  [ ] partial  [ ] enough to build
BUILD BRIEF:   [ ] none  [ ] draft  [ ] READY FOR BUILD
WEBSITE:       [ ] not started  [ ] building  [ ] preview ready
GHL:           [ ] not started  [ ] configured  [ ] staging lead OK
QA:            [ ] pending  [ ] pass  [ ] fail
CLIENT APPROVAL: [ ] none  [ ] design  [ ] content  [ ] launch
DOMAIN:        [ ] waiting  [ ] pointed  [ ] live SSL
LIVE LEAD TEST:[ ] pending  [ ] pass
TRAINING:      [ ] pending  [ ] done (date: )
CARE PLAN:     [ ] none  [ ] monthly  [ ] n/a

BLOCKERS:
NEXT ACTION:
OWNER:
DUE DATE:

Stage (1–8):
Industry pack used:
Preview URL:
Live URL:
GHL sub-account:
```

Copy into `00_Admin/dashboard.md` per client.

---

**End of Master Runbook.** Open source docs for depth; use this file for sequence.
