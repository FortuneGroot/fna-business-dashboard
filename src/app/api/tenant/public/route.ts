import { NextResponse } from "next/server";
import { BRAND } from "@/lib/brand";
import { authProvider } from "@/lib/auth/provider";

export const dynamic = "force-dynamic";

/**
 * Minimal public branding for login/chrome.
 * Contact details and owner configuration live on /api/tenant/config (authenticated).
 * AUTH_PROVIDER=supabase serves platform branding only: an anonymous caller has no workspace (§7.3).
 */
export async function GET() {
  const platform = {
    brandName: BRAND.name,
    productName: BRAND.product,
    legal: BRAND.legal,
    appHost: BRAND.appHost,
  };

  if (authProvider() === "supabase") {
    return NextResponse.json({
      ok: true,
      platform,
      client: {
        businessName: BRAND.name,
        logoUrl: "",
        hasLogo: false,
        colors: { primary: BRAND.colors.blue, secondary: BRAND.colors.gold, background: BRAND.colors.cream },
      },
    });
  }

  const { legacyBranding } = await import("@/lib/legacy/deployment");
  return NextResponse.json({ ok: true, platform, client: legacyBranding() });
}
