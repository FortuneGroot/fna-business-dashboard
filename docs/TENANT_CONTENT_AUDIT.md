# Tenant content audit (app runtime)

Classification legend:
- **PLATFORM BRAND** — keep (Fortune & Automations product)
- **F&A DEFAULT CONFIG** — allowed when `CLIENT_CONFIG_PATH` empty
- **CLIENT BUSINESS DATA** — must resolve from ClientConfig
- **HISTORICAL DOC** — ignore (`recovered/`, old checklists)

## Fixed this pass (CLIENT BUSINESS DATA)
| Location | Change |
|----------|--------|
| `src/content/snippets.json` | `{{CLIENT_BUSINESS_NAME}}` tokens |
| `src/app/library/page.tsx` | Resolves tokens via `clientBusinessName()` |
| `src/lib/mapping.ts` consent | `getConsentCopy(businessName)` |
| `src/app/support/page.tsx` | Uses configured client name + consent |
| Sidebar / Chrome / Settings / Dashboard | Already config-driven |

## Kept (PLATFORM BRAND)
- `layout.tsx` metadata, product name
- `brand.ts` product / legal / palette
- Help/onboarding/training explaining F&A as the vendor
- Login product title “Fortune & Automations Business Dashboard”

## Allowed (F&A DEFAULT CONFIG)
- Embedded `faLiveDefaultClientConfig()` location `kIXDnRuhkj6HLR1g6V6V`
- Default pipeline/stage/calendar names when no `CLIENT_CONFIG_PATH`

## Owner note
Support page still shows recovered F&A phone/email as **channel hints** until `owner-values` / client support fields are verified live. Prefer configured `supportEmail` for go-live copy.
