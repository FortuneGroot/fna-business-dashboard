import { NextResponse } from "next/server";
import { BRAND } from "@/lib/brand";
import {
  clientBusinessName,
  clientBrandColors,
  clientLegalName,
  getTenantConfig,
  platformBrandName,
  platformProductName,
} from "@/lib/tenant";

export const dynamic = "force-dynamic";

/** Public, non-secret tenant display fields for UI. */
export async function GET() {
  const cfg = getTenantConfig();
  return NextResponse.json({
    ok: true,
    platform: {
      brandName: platformBrandName(),
      productName: platformProductName(),
      legal: BRAND.legal,
    },
    client: {
      businessName: clientBusinessName(),
      legalBusinessName: clientLegalName(),
      timezone: cfg.business.timezone,
      industry: cfg.business.industry,
      logoUrl: cfg.business.logoUrl ? "[configured]" : "",
      hasLogo: Boolean(cfg.business.logoUrl || cfg.branding.logo),
      colors: clientBrandColors(),
      pipelineName: cfg.ghl.pipelineName,
      locationConfigured: Boolean(cfg.ghl.locationId),
    },
  });
}
