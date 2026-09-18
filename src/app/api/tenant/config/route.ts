import { NextRequest, NextResponse } from "next/server";
import { requireApiSession, getApiSession } from "@/lib/auth";
import { canAccessOwnerSettings } from "@/lib/auth/types";
import {
  clientBusinessName,
  clientBookingUrl,
  clientLegalName,
  clientReviewUrl,
  clientSupportEmail,
  getTenantConfig,
} from "@/lib/tenant";

export const dynamic = "force-dynamic";

/**
 * Authenticated tenant contact + configuration.
 * Contact fields: any signed-in role.
 * Owner configuration (pipeline / location flags): OWNER only.
 */
export async function GET(req: NextRequest) {
  const denied = await requireApiSession(req);
  if (denied) return denied;

  const session = await getApiSession(req);
  const cfg = getTenantConfig();
  const supportEmail = clientSupportEmail() || cfg.business.supportEmail || "";
  const phone = cfg.business.businessPhone || cfg.ghl.phoneNumber || "";
  const website = cfg.business.websiteUrl || "";
  const booking = clientBookingUrl();
  const review = clientReviewUrl();

  const body: Record<string, unknown> = {
    ok: true,
    client: {
      businessName: clientBusinessName(),
      legalBusinessName: clientLegalName(),
      timezone: cfg.business.timezone,
      industry: cfg.business.industry,
      supportEmail: supportEmail || "",
      phone: phone || "",
      website: website || "",
      bookingUrl: booking || "",
      reviewUrl: review || "",
    },
  };

  if (session && canAccessOwnerSettings(session.role)) {
    body.owner = {
      pipelineName: cfg.ghl.pipelineName,
      locationConfigured: Boolean(cfg.ghl.locationId),
    };
  }

  return NextResponse.json(body);
}
