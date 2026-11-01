"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button, Card, DataTable, Modal, PageHead } from "@/components/ui";
import { api, failure, when } from "@/lib/ui/native-api";
import { InviteLinkModal, ModeBadge, ReasonModal, StatusBadge, isLive, leftText, useNow, type WorkspaceStatus } from "./shared";

export type WorkspaceRow = {
  id: string;
  name: string;
  slug: string;
  status: WorkspaceStatus;
  createdAt: string;
  memberCount: number;
  ownerJoined: boolean;
};

export type GrantRow = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  workspaceStatus: WorkspaceStatus;
  adminEmail: string | null;
  mode: "read" | "write";
  reason: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  active: boolean;
  mine: boolean;
};

type Page = { items: WorkspaceRow[]; total: number; nextCursor: string | null };

const slugify = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);

function ProvisionWorkspace({ onDone }: { onDone: (url: string | null, message: string, id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ provisioningKey: "", name: "", slug: "", ownerEmail: "" });
  const [slugTouched, setSlugTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setForm((f) => ({ ...f, [key]: value, ...(key === "name" && !slugTouched ? { slug: slugify(value) } : {}) }));
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { status, body } = await api("/api/platform/workspaces", { method: "POST", body: JSON.stringify(form) });
    setBusy(false);
    if (status !== 200) {
      setError(status === 409
        ? "This provisioning key or slug is already used with different details."
        : failure(body, "The workspace could not be provisioned."));
      return;
    }
    setOpen(false);
    setForm({ provisioningKey: "", name: "", slug: "", ownerEmail: "" });
    setSlugTouched(false);
    onDone(
      (body.inviteUrl as string | null) ?? null,
      body.created
        ? `${form.name} was provisioned with 12 pipeline stages and no records.`
        : `${form.name} was already provisioned with these details. No new link was issued; replace the owner invitation from its page if needed.`,
      String(body.workspaceId),
    );
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>Provision workspace</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Provision workspace">
        <form onSubmit={submit}>
          <p className="muted" style={{ marginTop: 0 }}>
            Creates the workspace, its settings, and the 12-stage pipeline in one step, plus a single owner invitation link. No email is sent.
          </p>
          {error ? <div className="banner error" role="alert">{error}</div> : null}
          <label htmlFor="prov-name">Business name</label>
          <input id="prov-name" value={form.name} onChange={set("name")} maxLength={120} required />
          <label htmlFor="prov-slug">Slug</label>
          <input id="prov-slug" value={form.slug} onChange={(e) => { setSlugTouched(true); set("slug")(e); }} maxLength={48} required />
          <label htmlFor="prov-owner">Owner email</label>
          <input id="prov-owner" type="email" value={form.ownerEmail} onChange={set("ownerEmail")} maxLength={254} required />
          <label htmlFor="prov-key">Provisioning key</label>
          <input id="prov-key" value={form.provisioningKey} onChange={set("provisioningKey")} maxLength={120} required />
          <p className="muted" style={{ fontSize: "0.85rem" }}>Repeating the same key with the same details returns the existing workspace instead of a duplicate.</p>
          <div style={{ marginTop: "1rem" }}>
            <button className="btn" type="submit" disabled={busy}>{busy ? "Provisioning…" : "Provision"}</button>
          </div>
        </form>
      </Modal>
    </>
  );
}

export function PlatformWorkspaces({ initial, grants: initialGrants }: { initial: Page; grants: GrantRow[] }) {
  const router = useRouter();
  const now = useNow();
  const [page, setPage] = useState<Page>(initial);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [grants, setGrants] = useState(initialGrants);
  const [revoking, setRevoking] = useState<GrantRow | null>(null);
  const first = useRef(true);

  async function load(cursor: string | null) {
    setBusy(true);
    setError("");
    const params = new URLSearchParams({ limit: "25" });
    if (q.trim()) params.set("q", q.trim());
    if (status) params.set("status", status);
    if (cursor) params.set("cursor", cursor);
    const { status: code, body } = await api(`/api/platform/workspaces?${params}`);
    setBusy(false);
    if (code !== 200) {
      setError(failure(body, "Workspaces could not be loaded."));
      return;
    }
    const next = body as unknown as Page;
    setPage((prev) => (cursor ? { ...next, items: [...prev.items, ...next.items] } : next));
  }

  async function reloadGrants() {
    const { status: code, body } = await api("/api/platform/access");
    if (code === 200 && Array.isArray(body.items)) setGrants(body.items as GrantRow[]);
  }

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => void load(null), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, status]);

  async function openGrant(g: GrantRow) {
    const { status: code, body } = await api("/api/workspaces/active", { method: "POST", body: JSON.stringify({ workspaceId: g.workspaceId }) });
    if (code !== 200) {
      setError(failure(body, "That support session is no longer available."));
      await reloadGrants();
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  const live = grants.filter((g) => isLive(g, now));

  return (
    <>
      <PageHead
        title="Workspaces"
        description="Every client workspace. Business records stay private: opening one requires a time-limited, audited support grant."
        action={<ProvisionWorkspace onDone={(url, message) => { setInviteUrl(url); setNotice(message); void load(null); }} />}
      />
      {notice ? <div className="banner" role="status">{notice}</div> : null}
      {error ? <div className="banner error" role="alert">{error}</div> : null}

      <Card title="Active support access">
        {live.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>No support access is active.</p>
        ) : (
          <DataTable
            columns={["Workspace", "Access", "Expires", "Admin", "Reason", ""]}
            rows={live.map((g) => [
              <Link key="w" href={`/platform/workspaces/${g.workspaceId}`}>{g.workspaceName}</Link>,
              <ModeBadge key="m" mode={g.mode} />,
              `${when(g.expiresAt)} UTC${leftText(g.expiresAt, now)}`,
              g.mine ? "You" : g.adminEmail ?? "—",
              g.reason,
              <span key="a" style={{ display: "flex", gap: "0.35rem" }}>
                {g.mine ? <button className="btn sm" type="button" onClick={() => openGrant(g)} aria-label={`Open ${g.workspaceName}`}>Open</button> : null}
                <button className="btn ghost sm" type="button" onClick={() => setRevoking(g)} aria-label={`End access to ${g.workspaceName}`}>End access</button>
              </span>,
            ])}
          />
        )}
      </Card>

      <div style={{ height: "1.1rem" }} />

      <Card title="All workspaces" action={<span className="muted">{page.total} total</span>}>
        <div className="grid grid-2" style={{ marginBottom: "1rem" }}>
          <div>
            <label htmlFor="ws-search">Search workspaces</label>
            <input id="ws-search" type="search" placeholder="Name, slug, or owner email" value={q} maxLength={100} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div>
            <label htmlFor="ws-status">Status</label>
            <select id="ws-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
              <option value="archived">Archived</option>
            </select>
          </div>
        </div>
        <DataTable
          columns={["Workspace", "Slug", "Status", "Members", "Owner", "Created (UTC)"]}
          emptyTitle={q || status ? "No matching workspaces" : "No workspaces yet"}
          emptyNote={q || status ? "Try a different search or status." : "Provision the first workspace to get started."}
          rows={page.items.map((w) => [
            <Link key="n" href={`/platform/workspaces/${w.id}`}>{w.name}</Link>,
            w.slug,
            <StatusBadge key="s" status={w.status} />,
            String(w.memberCount),
            w.ownerJoined ? "Joined" : "Invitation pending",
            when(w.createdAt),
          ])}
        />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "0.9rem" }}>
          <span className="muted">Showing {page.items.length} of {page.total}.</span>
          {page.nextCursor ? (
            <button className="btn secondary sm" type="button" disabled={busy} onClick={() => load(page.nextCursor)}>Load more</button>
          ) : null}
        </div>
      </Card>

      <InviteLinkModal url={inviteUrl} title="Workspace provisioned" onClose={() => setInviteUrl(null)} />
      <ReasonModal
        open={Boolean(revoking)}
        title="End support access"
        intro={revoking ? `Access to ${revoking.workspaceName} ends immediately for its admin.` : ""}
        submitLabel="End access"
        initialReason="Support session finished"
        onClose={() => setRevoking(null)}
        onSubmit={async (reason) => {
          const { status: code, body } = await api(`/api/platform/access/${revoking!.id}`, { method: "DELETE", body: JSON.stringify({ reason }) });
          if (code !== 200) return failure(body, "Access could not be ended.");
          setNotice(`Support access to ${revoking!.workspaceName} ended.`);
          setRevoking(null);
          await reloadGrants();
          router.refresh();
          return null;
        }}
      />
    </>
  );
}
