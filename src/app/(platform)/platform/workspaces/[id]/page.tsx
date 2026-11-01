import { notFound } from "next/navigation";
import { PlatformShell } from "@/components/platform/PlatformShell";
import { PlatformWorkspaceDetail } from "@/components/platform/PlatformWorkspaceDetail";
import { ApiError, uuid } from "@/lib/api/native";
import { requirePlatformPage } from "@/lib/platform/page";
import { auditPage, getWorkspace, listGrants } from "@/lib/platform/console";

export const dynamic = "force-dynamic";

export const metadata = { title: "Workspace · Platform administration" };

export default async function PlatformWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const scope = await requirePlatformPage();
  const { id } = await params;
  if (!uuid.safeParse(id).success) notFound();
  const workspaceId = id.toLowerCase();
  let workspace;
  try {
    workspace = await getWorkspace(scope, workspaceId);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
  const [grants, audit] = await Promise.all([
    listGrants(scope, { workspaceId, include: "all", limit: 20 }),
    auditPage(scope, workspaceId, { limit: 25 }),
  ]);
  return (
    <PlatformShell email={scope.ctx.email}>
      <PlatformWorkspaceDetail workspace={workspace} grants={grants} audit={audit} />
    </PlatformShell>
  );
}
