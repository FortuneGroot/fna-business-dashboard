import { NextRequest, NextResponse } from "next/server";
import { loadEnv } from "@/lib/env";
import { logEvent } from "@/lib/logging";
import {
  ingestSyncPayload,
  safeIngestLogDetails,
  verifyWebhookSecret,
} from "@/lib/sync";

export const dynamic = "force-dynamic";

/**
 * HighLevel → F&A dashboard ingestion.
 * GET CRM reads are NOT used here. Workflows POST normalized events.
 * Never logs tokens or customer PII fields.
 */
export async function POST(req: NextRequest) {
  const env = loadEnv();
  const raw = await req.text();
  let payload: unknown = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    logEvent("webhook.rejected_json", { bytes: raw.length }, { level: "warn", dryRun: env.dryRun });
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const signature =
    req.headers.get("x-ghl-signature") || req.headers.get("x-webhook-secret") || "";
  const enforceFlag =
    (process.env.GHL_WEBHOOK_ENFORCE_SECRET || "").toLowerCase() === "true";
  const secretCheck = verifyWebhookSecret({
    signatureHeader: signature,
    dryRun: env.dryRun,
    secretConfigured: env.webhookSecretPresent,
    secretValue: process.env.GHL_WEBHOOK_SECRET || "",
    enforceFlag,
  });
  if (!secretCheck.ok) {
    logEvent(
      secretCheck.code === "secret_required"
        ? "webhook.secret_required"
        : "webhook.rejected_signature",
      {},
      { level: "warn", dryRun: env.dryRun }
    );
    return NextResponse.json(
      {
        ok: false,
        error:
          secretCheck.code === "secret_required"
            ? "Webhook secret required"
            : "Invalid webhook signature",
      },
      { status: 401 }
    );
  }

  const result = await ingestSyncPayload(raw, payload);
  logEvent(
    result.ok
      ? result.duplicate
        ? "webhook.duplicate"
        : "webhook.processed"
      : "webhook.rejected",
    safeIngestLogDetails(result, raw.length),
    {
      level: result.ok ? "info" : "warn",
      dryRun: env.dryRun,
    }
  );

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, code: result.code },
      { status: result.status }
    );
  }

  return NextResponse.json({
    ok: true,
    accepted: true,
    processed: result.processed,
    duplicate: Boolean(result.duplicate),
    eventType: result.eventType,
    dryRun: env.dryRun,
    message: result.message,
  });
}
