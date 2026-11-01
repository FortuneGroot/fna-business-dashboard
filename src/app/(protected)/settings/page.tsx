"use client";

import { AppShell } from "@/components/AppShell";
import { Card, Badge, EmptyState, PageHead } from "@/components/ui";
import { BRAND } from "@/lib/brand";
import type { AuthRole } from "@/lib/auth/types";
import { canAccessOwnerSettings, canAccessSyncHealth } from "@/lib/auth/types";
import { useCallback, useEffect, useState } from "react";
import {
  NativeAiReceptionist,
  NativeAudit,
  NativeBusinessProfile,
  NativeIntegrations,
  NativeTeam,
  useTeam,
} from "@/components/settings/NativeSettings";

type Health = {
  ok?: boolean;
  ghl?: {
    connected?: boolean;
    error?: string | null;
    locationName?: string | null;
  };
};

type TenantConfig = {
  client?: { businessName?: string; timezone?: string };
  owner?: { pipelineName?: string; locationConfigured?: boolean; stagesCount?: number };
};

type SyncHealth = {
  ok?: boolean;
  lastEventAt?: string | null;
  contactsCount?: number;
  opportunitiesCount?: number;
  appointmentsCount?: number;
  storageMode?: string;
};

export default function SettingsPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [tenant, setTenant] = useState<TenantConfig | null>(null);
  const [syncHealth, setSyncHealth] = useState<SyncHealth | null>(null);
  const [role, setRole] = useState<AuthRole | null>(null);
  const [native, setNative] = useState(false);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [loadState, setLoadState] = useState<"loading" | "ready" | "unauthorized" | "error">(
    "loading"
  );

  const load = useCallback(async () => {
    setLoadState("loading");
    setErr("");
    try {
      const [meRes, healthRes, tenantRes] = await Promise.all([
        fetch("/api/auth/me"),
        fetch("/api/health"),
        fetch("/api/tenant/config"),
      ]);
      let isNative = false;
      if (meRes.ok) {
        const me = await meRes.json();
        isNative = Boolean(me?.workspace);
        if (isNative) {
          setPermissions(Array.isArray(me.permissions) ? me.permissions : []);
          setMyUserId(typeof me.user?.id === "string" ? me.user.id : null);
        }
        const next = me?.user?.role ?? me?.legacyRole;
        if (next === "OWNER" || next === "ADMIN" || next === "CLIENT") setRole(next);
      }
      setNative(isNative);
      const syncRes = await fetch(isNative ? "/api/dashboard/summary" : "/api/sync/health");
      if (healthRes.status === 401 || healthRes.status === 403) {
        setLoadState("unauthorized");
        setErr("Your session expired or you are not signed in. Sign out and sign back in.");
        return;
      }
      if (tenantRes.status === 401 || tenantRes.status === 403) {
        setLoadState("unauthorized");
        setErr("Your session expired or you are not signed in. Sign out and sign back in.");
        return;
      }
      if (!healthRes.ok || !tenantRes.ok) {
        setLoadState("error");
        setErr("Could not load settings status. Try again in a moment.");
        return;
      }
      const healthJson = (await healthRes.json()) as Health;
      setHealth(healthJson);
      setTenant((await tenantRes.json()) as TenantConfig);
      if (syncRes.ok) {
        const body = await syncRes.json();
        setSyncHealth(isNative ? ({ ...body.summary, storageMode: body.storageMode } as SyncHealth) : (body as SyncHealth));
      } else if (syncRes.status === 403) {
        setSyncHealth(null);
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

  const can = (permission: string) => permissions.includes(permission);
  const team = useTeam(native && loadState === "ready" && can("team.read"));
  const isOwner = role ? canAccessOwnerSettings(role) : false;
  const canSeeSystem = role ? canAccessSyncHealth(role) : false;
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
        {native && loadState === "ready" ? (
          <NativeBusinessProfile canEdit={can("settings.write")} />
        ) : (
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
            Profile details are managed by Fortune & Automations for your Business Dashboard.
          </p>
        </Card>
        )}

        {native && can("integrations.read") ? (
          <NativeIntegrations pipelineName={tenant?.owner?.pipelineName} stagesCount={tenant?.owner?.stagesCount} />
        ) : isOwner && !native ? (
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
            {tenant?.owner?.pipelineName ? (
              <p className="muted">Pipeline: {tenant.owner.pipelineName}</p>
            ) : null}
            <p className="muted">
              Lists and metrics update when connected workflows send activity into this dashboard.
            </p>
          </Card>
        ) : (
          <Card title="Account">
            <p className="muted" style={{ marginTop: 0 }}>
              Integration and owner configuration are managed by your account owner.
            </p>
          </Card>
        )}
      </div>

      <div className="grid grid-2" style={{ marginTop: "1.1rem" }}>
        {native && can("team.read") ? (
          <NativeTeam permissions={permissions} myUserId={myUserId} team={team} />
        ) : (
          <Card title="Team / Staff">
            <EmptyState title="No team members yet" note="Invited staff accounts will appear here." />
          </Card>
        )}

        {canSeeSystem ? (
          <Card title="System status">
            {syncHealth ? (
              <>
                <p style={{ marginTop: 0 }}>
                  {native ? "Last activity:" : "Last sync event:"}{" "}
                  {syncHealth.lastEventAt
                    ? syncHealth.lastEventAt.slice(0, 19).replace("T", " ")
                    : "none yet"}
                </p>
                <p className="muted">
                  Contacts {syncHealth.contactsCount ?? 0} · Opportunities{" "}
                  {syncHealth.opportunitiesCount ?? 0} · Appointments{" "}
                  {syncHealth.appointmentsCount ?? 0}
                </p>
                <p className="muted">Storage: {syncHealth.storageMode || "—"}</p>
              </>
            ) : (
              <p className="muted" style={{ marginTop: 0 }}>
                System status is available to owners and admins after sign-in.
              </p>
            )}
          </Card>
        ) : (
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
        )}
      </div>

      {native && loadState === "ready" && (can("ai_receptionist.read") || can("audit.read")) ? (
        <div className="grid grid-2" style={{ marginTop: "1.1rem" }}>
          {can("ai_receptionist.read") ? (
            <NativeAiReceptionist canEdit={can("ai_receptionist.write")} members={team.members} />
          ) : null}
          {can("audit.read") ? <NativeAudit /> : null}
        </div>
      ) : null}
    </AppShell>
  );
}
