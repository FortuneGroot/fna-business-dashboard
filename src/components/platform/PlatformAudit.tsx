"use client";

import Link from "next/link";
import { useState } from "react";
import { DataTable } from "@/components/ui";
import { api, failure, when } from "@/lib/ui/native-api";
import { actionLabel } from "./shared";

export type AuditRow = {
  id: number;
  createdAt: string;
  action: string;
  reason: string | null;
  metadata: Record<string, unknown>;
  workspaceId: string | null;
  workspaceName: string | null;
  actorEmail: string | null;
};

function details(meta: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof meta.mode === "string") parts.push(meta.mode === "write" ? "read and write" : "read-only");
  if (typeof meta.expires_at === "string") parts.push(`until ${when(meta.expires_at)} UTC`);
  if (typeof meta.slug === "string") parts.push(`slug ${meta.slug}`);
  if (typeof meta.owner_email === "string") parts.push(`owner ${meta.owner_email}`);
  if (Array.isArray(meta.revoked_invitation_ids)) parts.push(`${meta.revoked_invitation_ids.length} earlier invitation(s) revoked`);
  return parts.join(" · ") || "—";
}

export function AuditTable({
  initial,
  endpoint,
  showWorkspace = true,
}: {
  initial: { items: AuditRow[]; nextCursor: string | null };
  endpoint: string;
  showWorkspace?: boolean;
}) {
  const [items, setItems] = useState(initial.items);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function more() {
    if (!cursor) return;
    setBusy(true);
    setError("");
    const { status, body } = await api(`${endpoint}?limit=50&cursor=${encodeURIComponent(cursor)}`);
    setBusy(false);
    if (status !== 200) {
      setError(failure(body, "More entries could not be loaded."));
      return;
    }
    setItems((prev) => [...prev, ...(body.items as AuditRow[])]);
    setCursor((body.nextCursor as string | null) ?? null);
  }

  const columns = ["When (UTC)", "Action", ...(showWorkspace ? ["Workspace"] : []), "By", "Reason", "Details"];
  return (
    <>
      {error ? <div className="banner error" role="alert">{error}</div> : null}
      <DataTable
        columns={columns}
        emptyTitle="No audit entries yet"
        rows={items.map((a) => [
          when(a.createdAt),
          actionLabel(a.action),
          ...(showWorkspace
            ? [a.workspaceId ? <Link key="w" href={`/platform/workspaces/${a.workspaceId}`}>{a.workspaceName ?? "—"}</Link> : "—"]
            : []),
          a.actorEmail ?? "—",
          a.reason ?? "—",
          details(a.metadata),
        ])}
      />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "0.9rem" }}>
        <span className="muted">Showing {items.length} entr{items.length === 1 ? "y" : "ies"}.</span>
        {cursor ? <button className="btn secondary sm" type="button" disabled={busy} onClick={more}>Load more</button> : null}
      </div>
    </>
  );
}
