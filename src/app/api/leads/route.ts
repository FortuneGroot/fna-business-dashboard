import { NextRequest, NextResponse } from "next/server";
import { legacyOnlyEndpoint } from "@/lib/auth/legacy-only";
import { loadEnv } from "@/lib/env";
import { logEvent } from "@/lib/logging";
import { validateInboundLead } from "@/lib/leads";
import { dedupeKey, mapLeadToGhlPayload } from "@/lib/mapping";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const unavailable = legacyOnlyEndpoint();
  if (unavailable) return unavailable;
  const env = loadEnv();
  const body = await req.json().catch(() => null);
  const result = validateInboundLead(body);
  if (!result.ok) {
    logEvent("lead.rejected", { errors: result.errors }, { level: "warn", dryRun: env.dryRun });
    return NextResponse.json({ ok: false, errors: result.errors }, { status: 400 });
  }

  const mapped = mapLeadToGhlPayload(result.lead);
  const key = dedupeKey(result.lead);

  if (!env.dryRun && env.allowProductionWrites) {
    logEvent("lead.blocked_no_live_writer", { key }, { level: "error", dryRun: false });
    return NextResponse.json(
      {
        ok: false,
        error:
          "Production contact writes are not implemented in this foundation. Keep GHL_DRY_RUN=true until separately authorized.",
      },
      { status: 409 }
    );
  }

  logEvent(
    "lead.dry_run",
    {
      key,
      service: result.lead.service,
      smsServiceConsent: result.lead.smsServiceConsent,
      smsMarketingConsent: result.lead.smsMarketingConsent,
      mappedFieldCount: Array.isArray(mapped.customFields) ? mapped.customFields.length : 0,
    },
    { dryRun: true }
  );

  return NextResponse.json({
    ok: true,
    dryRun: true,
    dedupeKey: key,
    ghlPayloadPreview: mapped,
    message: "Dry-run accepted. No CRM contact was created.",
  });
}
