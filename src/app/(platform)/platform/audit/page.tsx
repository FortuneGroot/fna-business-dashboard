import { Card, PageHead } from "@/components/ui";
import { AuditTable } from "@/components/platform/PlatformAudit";
import { PlatformShell } from "@/components/platform/PlatformShell";
import { requirePlatformPage } from "@/lib/platform/page";
import { auditPage } from "@/lib/platform/console";

export const dynamic = "force-dynamic";

export const metadata = { title: "Platform audit log" };

export default async function PlatformAuditPage() {
  const scope = await requirePlatformPage();
  const audit = await auditPage(scope, null, { limit: 50 });
  return (
    <PlatformShell email={scope.ctx.email}>
      <PageHead title="Audit log" description="Every platform action: provisioning, suspension, owner invitations, and support access, with who did it and why." />
      <Card title="Platform actions">
        <AuditTable initial={audit} endpoint="/api/platform/audit" />
      </Card>
    </PlatformShell>
  );
}
