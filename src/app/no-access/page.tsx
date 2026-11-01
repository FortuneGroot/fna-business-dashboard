import { redirect } from "next/navigation";
import { AccessNotice } from "@/components/AccessNotice";
import { authProvider } from "@/lib/auth/provider";

export const dynamic = "force-dynamic";

export default async function NoAccessPage() {
  if (authProvider() !== "supabase") redirect("/dashboard");
  const { evaluateContext, getPageSupabase, listMyWorkspacesForPage, requirePageContext } = await import("@/lib/authz/context");
  const ctx = await requirePageContext({ allowNoWorkspace: true });
  const denial = evaluateContext(ctx);
  if (denial === null) redirect("/dashboard");
  if (denial === "workspace_suspended") redirect("/workspace-suspended");
  if (ctx.isPlatformAdmin) redirect("/platform");
  const { platformStatus } = await import("@/lib/api/platform");
  const listedAdmin = await platformStatus(await getPageSupabase()).then((s) => s.listed, () => false);

  const choices = (await listMyWorkspacesForPage())
    .filter((w) => w.status === "active" || (w.status === "suspended" && w.grantMode === "read"))
    .map((w) => ({ id: w.id, name: w.name }));

  return (
    <AccessNotice
      title="No workspace access"
      message={
        choices.length
          ? "Choose a workspace to continue."
          : "Your account is not a member of an active workspace. Ask your workspace owner for an invitation, or contact Fortune & Automations."
      }
      choices={choices}
      action={listedAdmin ? { href: "/platform/mfa", label: "Verify authenticator for platform administration" } : undefined}
    />
  );
}
