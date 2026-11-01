import { requirePageSession } from "@/lib/auth/guards";
import { authProvider } from "@/lib/auth/provider";
import { SupportAccessProvider, type SupportAccessInfo } from "@/components/SupportAccess";
import { WorkspacePin } from "@/components/WorkspaceSwitcher";

export const dynamic = "force-dynamic";

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requirePageSession();
  let support: SupportAccessInfo | null = null;
  let workspaceId: string | null = null;
  if (authProvider() === "supabase") {
    const { getRequestContext } = await import("@/lib/authz/context");
    const ctx = await getRequestContext();
    workspaceId = ctx?.workspace?.id ?? null;
    if (ctx?.grant && ctx.workspace) {
      support = {
        grantId: ctx.grant.id,
        workspaceName: ctx.workspace.name,
        workspaceStatus: ctx.workspace.status,
        mode: ctx.grant.mode,
        expiresAt: ctx.grant.expiresAt,
      };
    }
  }
  return (
    <SupportAccessProvider value={support}>
      <WorkspacePin workspaceId={workspaceId} />
      {children}
    </SupportAccessProvider>
  );
}
