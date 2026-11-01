import { PlatformShell } from "@/components/platform/PlatformShell";
import { PlatformWorkspaces } from "@/components/platform/PlatformWorkspaces";
import { requirePlatformPage } from "@/lib/platform/page";
import { listGrants, searchWorkspaces } from "@/lib/platform/console";

export const dynamic = "force-dynamic";

export const metadata = { title: "Platform administration" };

export default async function PlatformHome() {
  const scope = await requirePlatformPage();
  const [page, grants] = await Promise.all([
    searchWorkspaces(scope, { limit: 25 }),
    listGrants(scope, { include: "active" }),
  ]);
  return (
    <PlatformShell email={scope.ctx.email}>
      <PlatformWorkspaces initial={page} grants={grants} />
    </PlatformShell>
  );
}
