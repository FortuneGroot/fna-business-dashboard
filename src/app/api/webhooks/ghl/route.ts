import { NextRequest, NextResponse } from "next/server";
import { loadEnv } from "@/lib/env";
import { logEvent } from "@/lib/logging";
import { BRAND } from "@/lib/brand";

export const dynamic = "force-dynamic";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i += 1) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export async function POST(req: NextRequest) {
  const env = loadEnv();
  const raw = await req.text();
  let payload: unknown = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const signature = req.headers.get("x-ghl-signature") || req.headers.get("x-webhook-secret") || "";
  if (!env.dryRun) {
    if (!env.webhookSecretPresent || !timingSafeEqual(signature, process.env.GHL_WEBHOOK_SECRET || "")) {
      logEvent("webhook.rejected_signature", {}, { level: "warn", dryRun: false });
      return NextResponse.json({ ok: false, error: "Invalid webhook signature" }, { status: 401 });
    }
  }

  const loc =
    typeof payload === "object" && payload && "locationId" in payload
      ? String((payload as { locationId?: string }).locationId || "")
      : "";
  if (loc && loc === BRAND.forbiddenMasterId) {
    logEvent("webhook.master_refused", { loc }, { level: "error" });
    return NextResponse.json({ ok: false, error: "Protected Master location refused" }, { status: 409 });
  }

  logEvent(
    "webhook.received",
    {
      bytes: raw.length,
      dryRun: env.dryRun,
      type:
        typeof payload === "object" && payload && "type" in payload
          ? (payload as { type?: string }).type
          : undefined,
    },
    { dryRun: env.dryRun }
  );

  return NextResponse.json({
    ok: true,
    accepted: true,
    processed: false,
    dryRun: env.dryRun,
    message: env.dryRun
      ? "Webhook stored as a structured log only. No CRM writes."
      : "Live webhook processing is not implemented in this foundation.",
  });
}
