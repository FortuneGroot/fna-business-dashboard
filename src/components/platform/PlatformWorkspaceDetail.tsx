"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Card, DataTable, PageHead } from "@/components/ui";
import { api, failure, when } from "@/lib/ui/native-api";
import type { GrantRow } from "./PlatformWorkspaces";
import { AuditTable, type AuditRow } from "./PlatformAudit";
import { InviteLinkModal, ModeBadge, ReasonModal, StatusBadge, isLive, useNow, type WorkspaceStatus } from "./shared";

export type WorkspaceDetail = {
  id: string;
  name: string;
  slug: string;
  status: WorkspaceStatus;
  createdAt: string;
  suspendedAt: string | null;
  suspendedReason: string | null;
  bootstrapOwnerEmail: string;
  ownerAcquiredAt: string | null;
  members: { owner: number; admin: number; employee: number };
  openOwnerInvitation: { id: string; createdAt: string; expiresAt: string } | null;
  canRotateBootstrap: boolean;
};

const DURATIONS = [15, 30, 60, 120, 240, 480];

function SupportAccessForm({ workspace }: { workspace: WorkspaceDetail }) {
  const router = useRouter();
  const suspended = workspace.status === "suspended";
  const [mode, setMode] = useState<"read" | "write">("read");
  const [minutes, setMinutes] = useState(30);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (reason.trim().length < 10) {
      setError("Give a reason of at least 10 characters.");
      return;
    }
    setBusy(true);
    setError("");
    const { status, body } = await api(`/api/platform/workspaces/${workspace.id}/access`, {
      method: "POST",
      body: JSON.stringify({ mode, reason: reason.trim(), durationMinutes: minutes }),
    });
    setBusy(false);
    if (status !== 200) {
      setError(status === 423 ? "Write access is not allowed while the workspace is suspended. Use read-only access." : failure(body, "Access could not be granted."));
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  if (workspace.status === "archived") return <p className="muted" style={{ margin: 0 }}>Archived workspaces cannot be opened.</p>;

  return (
    <form onSubmit={submit}>
      <p className="muted" style={{ marginTop: 0 }}>
        Opens this workspace as you, for a limited time. Every action is recorded with the grant. Platform access never changes roles, the team, or integration credentials.
      </p>
      {error ? <div className="banner error" role="alert">{error}</div> : null}
      <div className="grid grid-2">
        <div>
          <label htmlFor="grant-mode">Access</label>
          <select id="grant-mode" value={mode} onChange={(e) => setMode(e.target.value as "read" | "write")}>
            <option value="read">Read-only</option>
            <option value="write" disabled={suspended}>Read and write{suspended ? " (not while suspended)" : ""}</option>
          </select>
        </div>
        <div>
          <label htmlFor="grant-duration">Duration</label>
          <select id="grant-duration" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
            {DURATIONS.map((m) => (
              <option key={m} value={m}>{m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? "" : "s"}`}</option>
            ))}
          </select>
        </div>
      </div>
      <label htmlFor="grant-reason">Reason (recorded in both audit logs)</label>
      <textarea id="grant-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} required />
      <div style={{ marginTop: "0.9rem" }}>
        <button className="btn" type="submit" disabled={busy}>{busy ? "Opening…" : "Start support access"}</button>
      </div>
    </form>
  );
}

export function PlatformWorkspaceDetail({
  workspace: initialWorkspace,
  grants: initialGrants,
  audit,
}: {
  workspace: WorkspaceDetail;
  grants: GrantRow[];
  audit: { items: AuditRow[]; nextCursor: string | null };
}) {
  const router = useRouter();
  const now = useNow();
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [grants, setGrants] = useState(initialGrants);
  const [action, setAction] = useState<null | "suspend" | "reactivate" | "rotate" | { revoke: GrantRow }>(null);
  const [notice, setNotice] = useState("");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  async function refresh() {
    const { status, body } = await api(`/api/platform/workspaces/${workspace.id}`);
    if (status === 200) {
      setWorkspace(body.workspace as WorkspaceDetail);
      setGrants(body.grants as GrantRow[]);
    }
    router.refresh();
  }

  const m = workspace.members;
  const memberTotal = m.owner + m.admin + m.employee;

  return (
    <>
      <p style={{ margin: "0 0 0.6rem" }}><Link href="/platform">← All workspaces</Link></p>
      <PageHead title={workspace.name} description={`Slug ${workspace.slug} · created ${when(workspace.createdAt)} UTC`} action={<StatusBadge status={workspace.status} />} />
      {notice ? <div className="banner" role="status">{notice}</div> : null}

      <div className="grid grid-2">
        <Card title="Status">
          {workspace.status === "suspended" ? (
            <>
              <p style={{ marginTop: 0 }}>Suspended {when(workspace.suspendedAt)} UTC. Members cannot sign in to it.</p>
              <p className="muted">Reason: {workspace.suspendedReason ?? "—"}</p>
              <button className="btn" type="button" onClick={() => setAction("reactivate")}>Reactivate workspace</button>
            </>
          ) : workspace.status === "active" ? (
            <>
              <p style={{ marginTop: 0 }}>Active. Members can use the workspace.</p>
              <button className="btn secondary" type="button" onClick={() => setAction("suspend")}>Suspend workspace</button>
            </>
          ) : (
            <p style={{ marginTop: 0 }}>Archived.</p>
          )}
        </Card>

        <Card title="Members and owner">
          <p style={{ marginTop: 0 }}>
            {memberTotal} active member(s): {m.owner} owner(s), {m.admin} admin(s), {m.employee} employee(s).
          </p>
          <p className="muted">Bootstrap owner: {workspace.bootstrapOwnerEmail}</p>
          {workspace.ownerAcquiredAt ? (
            <p className="muted" style={{ marginBottom: 0 }}>An owner joined {when(workspace.ownerAcquiredAt)} UTC. Owners invite further owners.</p>
          ) : (
            <>
              <p className="muted">
                {workspace.openOwnerInvitation
                  ? `Owner invitation open until ${when(workspace.openOwnerInvitation.expiresAt)} UTC. The link was shown once when it was issued.`
                  : "No open owner invitation."}
              </p>
              {workspace.canRotateBootstrap ? (
                <button className="btn secondary" type="button" onClick={() => setAction("rotate")}>Replace owner invitation</button>
              ) : null}
            </>
          )}
        </Card>
      </div>

      <div style={{ height: "1.1rem" }} />

      <div className="grid grid-2">
        <Card title="Support access">
          <SupportAccessForm workspace={workspace} />
        </Card>
        <Card title="Access history">
          <DataTable
            columns={["Admin", "Access", "Status", "Reason"]}
            emptyTitle="No support access yet"
            rows={grants.map((g) => {
              const live = isLive(g, now);
              return [
                g.mine ? "You" : g.adminEmail ?? "—",
                <ModeBadge key="m" mode={g.mode} />,
                live ? (
                  <span key="s" style={{ display: "flex", gap: "0.35rem", alignItems: "center", flexWrap: "wrap" }}>
                    Until {when(g.expiresAt)} UTC
                    <button className="btn ghost sm" type="button" onClick={() => setAction({ revoke: g })} aria-label={`End access granted ${when(g.createdAt)}`}>End access</button>
                  </span>
                ) : g.revokedAt ? `Ended ${when(g.revokedAt)} UTC` : `Expired ${when(g.expiresAt)} UTC`,
                g.reason,
              ];
            })}
          />
        </Card>
      </div>

      <div style={{ height: "1.1rem" }} />

      <Card title="Audit log for this workspace">
        <AuditTable initial={audit} endpoint={`/api/platform/workspaces/${workspace.id}/audit`} showWorkspace={false} />
      </Card>

      <ReasonModal
        open={action === "suspend"}
        title="Suspend workspace"
        intro={`Every member of ${workspace.name} loses access on their next request. Data is kept.`}
        submitLabel="Suspend"
        onClose={() => setAction(null)}
        onSubmit={async (reason) => {
          const { status, body } = await api(`/api/platform/workspaces/${workspace.id}/suspend`, { method: "POST", body: JSON.stringify({ reason }) });
          if (status !== 200) return failure(body, "The workspace could not be suspended.");
          setAction(null);
          setNotice(`${workspace.name} is suspended.`);
          await refresh();
          return null;
        }}
      />
      <ReasonModal
        open={action === "reactivate"}
        title="Reactivate workspace"
        intro={`Members of ${workspace.name} regain access on their next request.`}
        submitLabel="Reactivate"
        onClose={() => setAction(null)}
        onSubmit={async (reason) => {
          const { status, body } = await api(`/api/platform/workspaces/${workspace.id}/reactivate`, { method: "POST", body: JSON.stringify({ reason }) });
          if (status !== 200) return failure(body, "The workspace could not be reactivated.");
          setAction(null);
          setNotice(`${workspace.name} is active again.`);
          await refresh();
          return null;
        }}
      />
      <ReasonModal
        open={action === "rotate"}
        title="Replace owner invitation"
        intro={`Any open owner invitation is revoked and a new link for ${workspace.bootstrapOwnerEmail} is shown once.`}
        submitLabel="Replace invitation"
        onClose={() => setAction(null)}
        onSubmit={async (reason) => {
          const { status, body } = await api(`/api/platform/workspaces/${workspace.id}/bootstrap-invitation`, { method: "POST", body: JSON.stringify({ reason }) });
          if (status !== 200) return status === 409 ? "An owner has already joined; owners invite further owners." : failure(body, "The invitation could not be replaced.");
          setAction(null);
          setInviteUrl(String(body.inviteUrl));
          setNotice(`A new owner invitation was issued (valid until ${when(String(body.expiresAt))} UTC).`);
          await refresh();
          return null;
        }}
      />
      <ReasonModal
        open={typeof action === "object" && action !== null}
        title="End support access"
        intro="Access ends immediately."
        submitLabel="End access"
        initialReason="Support session finished"
        onClose={() => setAction(null)}
        onSubmit={async (reason) => {
          if (typeof action !== "object" || !action) return null;
          const { status, body } = await api(`/api/platform/access/${action.revoke.id}`, { method: "DELETE", body: JSON.stringify({ reason }) });
          if (status !== 200) return failure(body, "Access could not be ended.");
          setAction(null);
          setNotice("Support access ended.");
          await refresh();
          return null;
        }}
      />
      <InviteLinkModal url={inviteUrl} title="New owner invitation" onClose={() => setInviteUrl(null)} />
    </>
  );
}
