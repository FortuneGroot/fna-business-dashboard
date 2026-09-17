"use client";

import { AppShell } from "@/components/AppShell";
import { Card, Badge, EmptyState, PageHead } from "@/components/ui";
import { BRAND } from "@/lib/brand";
import { missingOwnerValues } from "@/lib/owner-values";
import { useEffect, useState } from "react";

type Health = {
  ok?: boolean;
  dryRun?: boolean;
  ghl?: {
    connected?: boolean;
    mode?: string;
    error?: string | null;
    locationId?: string;
    locationName?: string | null;
  };
};

export default function SettingsPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setErr("Health endpoint is not reachable. Start the Next.js server."));
  }, []);

  const connected = Boolean(health?.ghl?.connected);
  const crmTone = connected ? "ok" : health?.ghl?.error ? "warn" : "neutral";
  const crmLabel = connected ? "Connected" : "Not connected";

  return (
    <AppShell>
      <PageHead
        title="Settings"
        description="Business profile, integrations, and preferences for this shell. No billing, DNS, or OAuth controls live here yet."
      />
      {err ? <div className="banner error">{err}</div> : null}

      <div className="grid grid-2">
        <Card title="Business Profile">
          <label htmlFor="biz-name">Business name</label>
          <input id="biz-name" defaultValue={BRAND.name} disabled />
          <label htmlFor="biz-tz">Timezone</label>
          <input id="biz-tz" defaultValue={BRAND.timezone} disabled />
          <label htmlFor="biz-hours">Business hours</label>
          <input id="biz-hours" placeholder="Not set yet" disabled />
          <p className="muted" style={{ marginTop: "0.6rem" }}>
            Read-only preview. Editing turns on once account settings are wired to the CRM.
          </p>
        </Card>

        <Card title="Integrations" action={<Badge tone={crmTone}>{crmLabel}</Badge>}>
          <p>
            CRM connection: {health ? health.ghl?.mode || "unknown" : "checking…"}
            {health?.ghl?.locationName ? <span> — {health.ghl.locationName}</span> : null}
            {health?.ghl?.error ? <span className="muted"> — {health.ghl.error}</span> : null}
          </p>
          <p className="muted">
            Agency PIT health proves authentication and live location only. Dashboard lists populate
            from HighLevel workflow webhooks (/api/webhooks/ghl). See /api/sync/health for sync counts.
          </p>
        </Card>
      </div>

      <div className="grid grid-2" style={{ marginTop: "1.1rem" }}>
        <Card title="Team / Staff">
          <EmptyState title="No team members yet" note="Invited staff accounts will appear here." />
        </Card>

        <Card title="Notifications">
          <label className="check">
            <input type="checkbox" disabled />
            <span>New lead alerts</span>
          </label>
          <label className="check">
            <input type="checkbox" disabled />
            <span>Daily activity summary</span>
          </label>
          <label className="check">
            <input type="checkbox" disabled />
            <span>Overdue follow-up reminders</span>
          </label>
          <p className="muted" style={{ marginTop: "0.4rem" }}>
            Notification delivery isn&apos;t connected yet — preferences shown for preview only.
          </p>
        </Card>
      </div>

      <div style={{ marginTop: "1.1rem" }}>
        <Card title="Owner values still required">
          <p className="muted" style={{ marginBottom: "0.6rem" }}>
            Single app insertion point: <code>src/lib/owner-values.ts</code>. Mirror the same
            verified value into the matching GHL Custom Value. Do not invent values.
          </p>
          <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
            {missingOwnerValues().map((v) => (
              <li key={v.key}>
                {v.label} → {v.ghlCustomValueName}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </AppShell>
  );
}
