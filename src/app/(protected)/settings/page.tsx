"use client";

import { AppShell } from "@/components/AppShell";
import { Card, Badge, EmptyState, PageHead } from "@/components/ui";
import { BRAND } from "@/lib/brand";
import { useCallback, useEffect, useState } from "react";

type Health = {
  ok?: boolean;
  ghl?: {
    connected?: boolean;
    error?: string | null;
    locationName?: string | null;
  };
};

type TenantPublic = {
  client?: { businessName?: string; timezone?: string };
  platform?: { brandName?: string; productName?: string };
};

export default function SettingsPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [tenant, setTenant] = useState<TenantPublic | null>(null);
  const [err, setErr] = useState("");
  const [loadState, setLoadState] = useState<"loading" | "ready" | "unauthorized" | "error">(
    "loading"
  );

  const load = useCallback(async () => {
    setLoadState("loading");
    setErr("");
    try {
      const [healthRes, tenantRes] = await Promise.all([
        fetch("/api/health"),
        fetch("/api/tenant/public"),
      ]);
      if (healthRes.status === 401 || healthRes.status === 403) {
        setLoadState("unauthorized");
        setErr("Your session expired or you are not signed in. Sign out and sign back in.");
        return;
      }
      if (!healthRes.ok) {
        setLoadState("error");
        setErr("Could not load settings status. Try again in a moment.");
        return;
      }
      const healthJson = (await healthRes.json()) as Health;
      setHealth(healthJson);
      if (tenantRes.ok) {
        setTenant((await tenantRes.json()) as TenantPublic);
      }
      setLoadState("ready");
    } catch {
      setLoadState("error");
      setErr("Network error while loading settings.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connected = Boolean(health?.ghl?.connected);
  const crmTone = connected ? "ok" : health?.ghl?.error ? "warn" : "neutral";
  const crmLabel =
    loadState === "loading" ? "Checking…" : connected ? "Connected" : "Not connected";
  const bizName = tenant?.client?.businessName || BRAND.name;
  const bizTz = tenant?.client?.timezone || BRAND.timezone;

  return (
    <AppShell>
      <PageHead
        title="Settings"
        description="Business profile and connection status for your Business Dashboard."
      />
      {err ? (
        <div className="banner error" role="alert">
          {err}
          {loadState === "error" || loadState === "unauthorized" ? (
            <div style={{ marginTop: "0.6rem" }}>
              <button type="button" className="btn secondary sm" onClick={() => void load()}>
                Try again
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="grid grid-2">
        <Card title="Business Profile">
          <label htmlFor="biz-name">Business name</label>
          <input id="biz-name" value={bizName} readOnly disabled aria-disabled="true" />
          <label htmlFor="biz-tz">Timezone</label>
          <input id="biz-tz" value={bizTz} readOnly disabled aria-disabled="true" />
          <label htmlFor="biz-hours">Business hours</label>
          <input
            id="biz-hours"
            placeholder="Not set yet"
            disabled
            aria-disabled="true"
            title="Editing business hours is not available yet"
          />
          <p className="muted" style={{ marginTop: "0.6rem" }}>
            Profile details are managed by Fortune & Automations for{" "}
            {tenant?.platform?.productName || BRAND.product}.
          </p>
        </Card>

        <Card title="Integrations" action={<Badge tone={crmTone}>{crmLabel}</Badge>}>
          <p>
            {connected
              ? "Your CRM connection is active."
              : loadState === "loading"
                ? "Checking connection status…"
                : "Your CRM connection is not active yet."}
            {health?.ghl?.locationName ? (
              <span className="muted"> Location label: {health.ghl.locationName}</span>
            ) : null}
          </p>
          <p className="muted">
            Lists and metrics update when connected workflows send activity into this dashboard.
          </p>
        </Card>
      </div>

      <div className="grid grid-2" style={{ marginTop: "1.1rem" }}>
        <Card title="Team / Staff">
          <EmptyState title="No team members yet" note="Invited staff accounts will appear here." />
        </Card>

        <Card title="Notifications">
          <p className="muted" style={{ marginTop: 0 }}>
            Notification preferences are not available yet.
          </p>
          <fieldset disabled aria-disabled="true" className="disabled-controls">
            <legend className="sr-only">Notification preferences (unavailable)</legend>
            <label className="check">
              <input type="checkbox" disabled tabIndex={-1} />
              <span>New lead alerts (coming soon)</span>
            </label>
            <label className="check">
              <input type="checkbox" disabled tabIndex={-1} />
              <span>Daily activity summary (coming soon)</span>
            </label>
            <label className="check">
              <input type="checkbox" disabled tabIndex={-1} />
              <span>Overdue follow-up reminders (coming soon)</span>
            </label>
          </fieldset>
        </Card>
      </div>
    </AppShell>
  );
}
