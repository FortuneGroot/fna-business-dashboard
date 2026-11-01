import { NextResponse } from "next/server";
import { authProvider } from "./provider";

/**
 * Deployment-wide legacy endpoints (spec §7.6, removed in P7) report one deployment's sync store,
 * client config, CRM connection, or process log. With AUTH_PROVIDER=supabase that data belongs to no
 * workspace, so these endpoints answer 404 `not_available` (after their own authentication).
 */
export function legacyOnlyEndpoint(): NextResponse | null {
  if (authProvider() !== "supabase") return null;
  return NextResponse.json({ ok: false, error: "Not available", code: "not_available" }, { status: 404 });
}
