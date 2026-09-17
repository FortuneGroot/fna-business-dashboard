# Website → Vercel → GHL architecture (prep only)

**Do not deploy destructive live changes. Do not write production contacts.**

```
Website / branded app form
        │  POST JSON (fake contacts in dry-run)
        ▼
Vercel  /api/leads
        │  validate → consent map → UTM → dedupe key
        │  structured log
        ▼
  GHL_DRY_RUN=true  →  stop (preview payload only)
  future authorized live mode
        ▼
HighLevel PIT  POST /contacts/  location kIXDnRuhkj6HLR1g6V6V
        │  custom field IDs from LIVE_RUNTIME_CROSSWALK
        ▼
Opportunity on pipeline 6XevPh4T3rX0qAYRfuta stage NAME "New Lead"
```

Inbound HighLevel events (future): `POST /api/webhooks/ghl` — signature required when dry-run is false. Master location `NQwD3zdWCuBSVpOuzybj` is refused.

## Consent mapping

| Form checkbox | GHL field | Rule |
|---|---|---|
| SMS service (independent) | `sms_service_consent` `k7bYDjP8GdoWntlEr6CP` | Unchecked still saves inquiry; no SMS |
| SMS marketing (independent) | `sms_marketing_consent` `eA7KEjSsMs2wjJgXeNnn` | Never implied by phone number |
| Email updates | `email_marketing_permission` `MrqMzPurFZywYbjCRDdT` | Unknown unless checked |

## UTM / source

Store `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `gclid`, `fbclid` on the payload. Tag `source-website`. Do not overwrite an existing acquisition source on repeat submits (design rule — live writer not implemented).

## Dedup

Key = `email:{lower}|phone:{digits}`. One open opportunity per contact on pipeline `6XevPh4T3rX0qAYRfuta`. Bind by stage **name**.

## Failure / retry

Log `lead.rejected` / `lead.dry_run` / `webhook.received`. No automatic retry loop. Missing token → no GHL call.

## Test payload (fake only)

```json
{
  "name": "QA Test Lead",
  "email": "qa.lead@example.invalid",
  "phone": "555-010-0199",
  "service": "Automation",
  "message": "Dry-run only. Do not create a real contact.",
  "smsServiceConsent": false,
  "smsMarketingConsent": false,
  "source": "website-test",
  "utm": { "utm_source": "qa", "utm_medium": "manual" }
}
```
