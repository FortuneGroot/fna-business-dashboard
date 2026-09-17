# Post-clone validator

Run against the **clone** location, never against LIVE F&A or Master.

| # | Check | Pass rule |
|---|---|---|
| 1 | Location ID | Not `kIXDnRuhkj6HLR1g6V6V`, not `NQwD3zdWCuBSVpOuzybj` |
| 2 | Pipeline | New ID; stage NAMES match; not `iYIxeKOdg5jkoAfKNnYM` |
| 3 | Custom values | Client facts only |
| 4 | Custom fields | Required names present; IDs may differ |
| 5 | Forms | Five intended forms; unpublished until client QA |
| 6 | Calendars | Five mapped; hosts assigned; no invented Automation Consultation unless client wants it |
| 7 | Workflows | Draft/OFF; no F&A-only IDs hardcoded |
| 8 | Email/SMS | Merge fields resolve; no example.invalid in live templates |
| 9 | Phone | Clone-specific or explicitly unused |
| 10 | OAuth | Client accounts only |
| 11 | AI | Conversation AI OFF until client yes |
| 12 | Brand | No Fortune & Enterprise; no Master Core strings |
| 13 | Test data | Fake contacts deleted |
| 14 | Domain | Client sending/link domains, not F&A's |
