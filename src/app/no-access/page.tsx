import { redirect } from "next/navigation";
import { AccessNotice } from "@/components/AccessNotice";
import { authProvider } from "@/lib/auth/provider";

export const dynamic = "force-dynamic";

export default async function NoAccessPage() {
  if (authProvider() !== "supabase") redirect("/dashboard");
  const { evaluateContext, listMyWorkspacesForPage, requirePageContext } = await import("@/lib/authz/context");
  const ctx = await requirePageContext({ allowNoWorkspace: true });
  const denial = evaluateContext(ctx);
  if (denial === null) redirect("/dashboard");
  if (denial === "workspace_suspended") redirect("/workspace-suspended");

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
    />
  );
}
