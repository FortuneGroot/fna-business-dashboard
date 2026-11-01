import { NextRequest, NextResponse } from "next/server";
import { requireApiSession, getApiSession } from "@/lib/auth";
import { canAccessOwnerSettings } from "@/lib/auth/types";
import { authProvider } from "@/lib/auth/provider";
import { readApi } from "@/lib/data/api";
import type { WorkspaceView } from "@/lib/data/types";
import { getTenantConfig } from "@/lib/tenant";

export const dynamic = "force-dynamic";

function clientBlock(view: WorkspaceView) {
  return {
    businessName: view.businessName,
    legalBusinessName: view.legalName,
    timezone: view.timezone,
    industry: view.industry,
    supportEmail: view.supportEmail || "",
    phone: view.phone || "",
    website: view.website || "",
    bookingUrl: view.bookingUrl || "",
    reviewUrl: view.reviewUrl || "",
  };
}

/**
 * Authenticated tenant contact + configuration.
 * AUTH_PROVIDER=supabase: the active workspace's settings (`settings.read`); holders of
 * `settings.write` also get `owner: { pipelineName, stagesCount }` (spec §7.3).
 * AUTH_PROVIDER=legacy: deployment config; owner configuration for OWNER only.
 */
export async function GET(req: NextRequest) {
  if (authProvider() === "supabase") {
    return readApi(req, "settings.read", async (data) => {
      const view = await data.workspace();
      return {
        ok: true,
        client: clientBlock(view),
        ...(data.can("settings.write")
          ? { owner: { pipelineName: view.pipelineName, stagesCount: view.stageNames.length } }
          : {}),
      };
    });
  }

  const denied = await requireApiSession(req);
  if (denied) return denied;

  const session = await getApiSession(req);
  const { legacyWorkspaceView } = await import("@/lib/data/legacy");
  const body: Record<string, unknown> = { ok: true, client: clientBlock(legacyWorkspaceView()) };

  if (session && canAccessOwnerSettings(session.role)) {
    const cfg = getTenantConfig();
    body.owner = {
      pipelineName: cfg.ghl.pipelineName,
      locationConfigured: Boolean(cfg.ghl.locationId),
    };
  }

  return NextResponse.json(body);
}
