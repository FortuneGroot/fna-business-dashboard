import { NextResponse } from "next/server";
import { BRAND } from "@/lib/brand";
import {
  clientBusinessName,
  clientBrandColors,
  clientBookingUrl,
  clientLegalName,
  clientLogoUrl,
  clientReviewUrl,
  clientSupportEmail,
  getTenantConfig,
  platformBrandName,
  platformProductName,
} from "@/lib/tenant";

export const dynamic = "force-dynamic";

/** Public, non-secret tenant display fields for UI. */
export async function GET() {
  const cfg = getTenantConfig();
  const logo = clientLogoUrl();
  const supportEmail = clientSupportEmail() || cfg.business.supportEmail || "";
  const phone = cfg.business.businessPhone || cfg.ghl.phoneNumber || "";
  const website = cfg.business.websiteUrl || "";
  const booking = clientBookingUrl();
  const review = clientReviewUrl();

  return NextResponse.json({
    ok: true,
    platform: {
      brandName: platformBrandName(),
      productName: platformProductName(),
      legal: BRAND.legal,
      appHost: BRAND.appHost,
    },
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
      logoUrl: logo || "",
      hasLogo: Boolean(logo),
      colors: clientBrandColors(),
      pipelineName: cfg.ghl.pipelineName,
      locationConfigured: Boolean(cfg.ghl.locationId),
    },
  });
}
