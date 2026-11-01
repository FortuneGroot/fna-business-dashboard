"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Modal } from "@/components/ui";
import { api, dollars, failure, loadMembers, toCents, type Member } from "@/lib/ui/native-api";
import { ContactPicker, MemberSelect } from "./pickers";

/* Opportunity controls for the native pipeline board (AUTH_PROVIDER=supabase). The board itself stays
 * server-rendered; these islands call /api/opportunities and refresh the page after each change. */

export type BoardStage = { id: string; name: string };

type Opportunity = {
  id: string;
  title: string;
  valueCents: number;
  stageId: string;
  contactId: string;
  contactName: string | null;
  assignedUserId: string | null;
  status: string;
};

function useMembers(open: boolean) {
  const [members, setMembers] = useState<Member[]>([]);
  useEffect(() => {
    if (open && !members.length) void loadMembers().then(setMembers);
  }, [open, members.length]);
  return members;
}

export function AddOpportunity({ stages }: { stages: BoardStage[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [contactId, setContactId] = useState("");
  const [stageId, setStageId] = useState(stages[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [value, setValue] = useState("");
  const [assignee, setAssignee] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const members = useMembers(open);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const cents = value.trim() ? toCents(value) : 0;
    if (cents === null) {
      setError("Enter the value in dollars, like 1500 or 1500.50.");
      return;
    }
    setBusy(true);
    const { body } = await api("/api/opportunities", {
      method: "POST",
      body: JSON.stringify({ contactId, stageId, title, valueCents: cents, assignedUserId: assignee || null }),
    });
    setBusy(false);
    if (!body.ok) {
      setError(failure(body, "Could not add the opportunity."));
      return;
    }
    setOpen(false);
    setTitle("");
    setValue("");
    setContactId("");
    setError("");
    router.refresh();
  }

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)} disabled={!stages.length}>
        Add opportunity
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Add opportunity">
        <form onSubmit={submit} aria-label="Add opportunity">
          {error ? <div className="banner error" role="alert">{error}</div> : null}
          <ContactPicker id="opp-contact" value={contactId} onChange={setContactId} />
          <label htmlFor="opp-title">Title</label>
          <input id="opp-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required />
          <label htmlFor="opp-stage">Stage</label>
          <select id="opp-stage" value={stageId} onChange={(e) => setStageId(e.target.value)}>
            {stages.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <label htmlFor="opp-value">Value (USD)</label>
          <input id="opp-value" inputMode="decimal" placeholder="0.00" value={value} onChange={(e) => setValue(e.target.value)} />
          <MemberSelect id="opp-assignee" label="Assigned to" value={assignee} members={members} onChange={setAssignee} />
          <div style={{ marginTop: "0.8rem" }}>
            <Button type="submit" disabled={busy}>Add opportunity</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

export function EditOpportunity({ id, stages, canDelete }: { id: string; stages: BoardStage[]; canDelete: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [opp, setOpp] = useState<Opportunity | null>(null);
  const [title, setTitle] = useState("");
  const [value, setValue] = useState("");
  const [assignee, setAssignee] = useState("");
  const [stageId, setStageId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const members = useMembers(open);

  async function show() {
    setOpen(true);
    setError("");
    const { body } = await api(`/api/opportunities/${id}`);
    if (!body.ok) {
      setError(failure(body, "Could not load this opportunity."));
      return;
    }
    const o = body.opportunity as Opportunity;
    setOpp(o);
    setTitle(o.title);
    setValue((o.valueCents / 100).toFixed(2));
    setAssignee(o.assignedUserId ?? "");
    setStageId(o.stageId);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!opp) return;
    const cents = toCents(value || "0");
    if (cents === null) {
      setError("Enter the value in dollars, like 1500 or 1500.50.");
      return;
    }
    setBusy(true);
    const patch: Record<string, unknown> = {};
    if (title !== opp.title) patch.title = title;
    if (cents !== opp.valueCents) patch.valueCents = cents;
    if ((assignee || null) !== opp.assignedUserId) patch.assignedUserId = assignee || null;
    if (Object.keys(patch).length) {
      const { body } = await api(`/api/opportunities/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
      if (!body.ok) {
        setBusy(false);
        setError(failure(body, "Could not save the opportunity."));
        return;
      }
    }
    if (stageId !== opp.stageId) {
      const { body } = await api(`/api/opportunities/${id}/move`, { method: "POST", body: JSON.stringify({ stageId }) });
      if (!body.ok) {
        setBusy(false);
        setError(failure(body, "Could not move the opportunity."));
        return;
      }
    }
    setBusy(false);
    setOpen(false);
    router.refresh();
  }

  async function remove() {
    if (!opp || !window.confirm(`Delete “${opp.title}”? It is removed from the board and totals.`)) return;
    const { body } = await api(`/api/opportunities/${id}`, { method: "DELETE" });
    if (!body.ok) {
      setError(failure(body, "Could not delete the opportunity."));
      return;
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      {" "}
      <button type="button" className="btn ghost sm" onClick={() => void show()} aria-label="Edit opportunity">
        Edit
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={opp ? opp.title : "Opportunity"}>
        {error ? <div className="banner error" role="alert">{error}</div> : null}
        {opp ? (
          <form onSubmit={save} aria-label="Edit opportunity">
            <p className="muted" style={{ marginTop: 0 }}>
              {opp.contactName ?? "Contact"} · {dollars(opp.valueCents)} · {opp.status}
            </p>
            <label htmlFor={`t-${id}`}>Title</label>
            <input id={`t-${id}`} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required />
            <label htmlFor={`v-${id}`}>Value (USD)</label>
            <input id={`v-${id}`} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
            <label htmlFor={`s-${id}`}>Stage</label>
            <select id={`s-${id}`} value={stageId} onChange={(e) => setStageId(e.target.value)}>
              {stages.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <MemberSelect id={`a-${id}`} label="Assigned to" value={assignee} members={members} onChange={setAssignee} />
            <div className="quick-actions" style={{ marginTop: "0.8rem" }}>
              <Button type="submit" disabled={busy}>Save</Button>
              {canDelete ? (
                <Button variant="ghost" onClick={() => void remove()}>
                  Delete opportunity
                </Button>
              ) : null}
            </div>
          </form>
        ) : null}
      </Modal>
    </>
  );
}

type StageItem = { id: string; title: string; valueCents: number; contactName: string | null };

/** Opportunities of one stage beyond those the board renders, paged from /api/opportunities?stageId=. */
export function StageMore({
  stageId,
  hidden,
  shownIds,
  stages,
  canEdit,
  canDelete,
}: {
  stageId: string;
  hidden: number;
  shownIds: string[];
  stages: BoardStage[];
  canEdit: boolean;
  canDelete: boolean;
}) {
  const [items, setItems] = useState<StageItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load(after: string | null) {
    setBusy(true);
    setError("");
    const q = new URLSearchParams({ stageId, limit: "50" });
    if (after) q.set("cursor", after);
    const { body } = await api(`/api/opportunities?${q}`);
    setBusy(false);
    if (!body.ok) {
      setError(failure(body, "Could not load more opportunities."));
      return;
    }
    const page = (body.items as StageItem[]).filter((o) => !shownIds.includes(o.id));
    setItems((prev) => [...(after && prev ? prev : []), ...page]);
    setCursor((body.nextCursor as string | null) ?? null);
  }

  return (
    <>
      {items?.map((o) => (
        <li key={o.id} className="muted">
          {o.title} · {dollars(o.valueCents)}
          {o.contactName ? ` · ${o.contactName}` : ""}
          {canEdit ? <EditOpportunity id={o.id} stages={stages} canDelete={canDelete} /> : null}
        </li>
      ))}
      {error ? <li className="muted" role="alert">{error}</li> : null}
      {items === null || cursor ? (
        <li style={{ listStyle: "none", marginLeft: "-1.1rem", marginTop: "0.4rem" }}>
          <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void load(items === null ? null : cursor)}>
            {busy ? "Loading…" : items === null ? `Show ${hidden} more` : "Show more"}
          </button>
        </li>
      ) : null}
    </>
  );
}
