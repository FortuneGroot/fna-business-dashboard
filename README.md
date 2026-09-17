# Fortune & Automations — client application shell

Branded preview for **app.fortuneandautomations.com**.

This is a production-quality **shell**. Sign-in, HighLevel writes, DNS, OAuth, and messaging are **not connected**. Placeholders are labeled as such.

## Local

```bash
cp .env.example .env.local
npm install
npm run dev
```

Open http://localhost:3000

## Safety

- Default `GHL_DRY_RUN=true`
- `ALLOW_PRODUCTION_CONTACT_WRITES` must stay `false` unless separately authorized
- Location ID must be `kIXDnRuhkj6HLR1g6V6V`
- Protected Master `NQwD3zdWCuBSVpOuzybj` is refused by the GHL client
- No secrets in Git

## Deploy

Point a Vercel project at this folder. Custom domain `app.fortuneandautomations.com` is an **owner DNS** step — not done by this repo.

## QA

```bash
python qa/run_static_audit.py
```
