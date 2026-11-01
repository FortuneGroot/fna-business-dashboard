import { redirect } from "next/navigation";
import { AccessNotice } from "@/components/AccessNotice";
import { authProvider } from "@/lib/auth/provider";

export const dynamic = "force-dynamic";

export default async function WorkspaceSuspendedPage() {
  if (authProvider() !== "supabase") redirect("/dashboard");
  const { evaluateContext, listMyWorkspacesForPage, requirePageContext } = await import("@/lib/authz/context");
  const ctx = await requirePageContext({ allowNoWorkspace: true });
  const denial = evaluateContext(ctx);
  if (denial === null) redirect("/dashboard");
  if (denial !== "workspace_suspended") redirect("/no-access");

  const choices = (await listMyWorkspacesForPage())
    .filter((w) => w.id !== ctx.workspace?.id && w.status === "active")
    .map((w) => ({ id: w.id, name: w.name }));

  return (
    <AccessNotice
      title="Workspace suspended"
      message={`${ctx.workspace?.name ?? "This workspace"} is currently suspended. Contact Fortune & Automations for help.`}
      choices={choices}
    />
  );
}
