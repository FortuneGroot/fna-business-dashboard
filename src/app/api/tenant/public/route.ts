import { NextResponse } from "next/server";
import { BRAND } from "@/lib/brand";
import {
  clientBusinessName,
  clientBrandColors,
  clientLogoUrl,
  platformBrandName,
  platformProductName,
} from "@/lib/tenant";

export const dynamic = "force-dynamic";

/**
 * Minimal public branding for login/chrome.
 * Contact details and owner configuration live on /api/tenant/config (authenticated).
 */
export async function GET() {
  const logo = clientLogoUrl();

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
      logoUrl: logo || "",
      hasLogo: Boolean(logo),
      colors: clientBrandColors(),
    },
  });
}
