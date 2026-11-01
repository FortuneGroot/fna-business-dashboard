import "server-only";
import { notFound, redirect } from "next/navigation";
import { authProvider } from "@/lib/auth/provider";
import { platformStatus, type PlatformScope } from "@/lib/api/platform";

/**
 * Guard for /platform pages. Legacy mode and non-admins get 404 (the console is not advertised);
 * a listed admin whose session is AAL1 is sent to /platform/mfa; signed-out users to /login.
 * Returns the admin's own-JWT scope for the console's RPCs.
 */
export async function requirePlatformPage(): Promise<PlatformScope> {
  if (authProvider() !== "supabase") notFound();
  const { getPageSupabase, requirePageContext } = await import("@/lib/authz/context");
  const ctx = await requirePageContext({ allowNoWorkspace: true });
  const supabase = await getPageSupabase();
  if (ctx.isPlatformAdmin) return { supabase, ctx };
  if ((await platformStatus(supabase)).listed) redirect("/platform/mfa");
  notFound();
}

/** Guard for /platform/mfa: a signed-in, listed platform admin (any assurance level). */
export async function requireListedPlatformAdmin() {
  if (authProvider() !== "supabase") notFound();
  const { getPageSupabase, requirePageContext } = await import("@/lib/authz/context");
  const ctx = await requirePageContext({ allowNoWorkspace: true });
  const status = await platformStatus(await getPageSupabase());
  if (!status.listed) notFound();
  return { ctx, status };
}
