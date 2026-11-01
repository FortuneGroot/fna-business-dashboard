"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { StatusBanner } from "@/components/Chrome";
import { Button, Card, DataTable, EmptyState, Modal, PageHead } from "@/components/ui";
import { api, failure, loadMembers, when, type Member } from "@/lib/ui/native-api";
import { dataCopy } from "@/lib/ui/sync-copy";

const copy = dataCopy(true);

/* Contacts in a native workspace (AUTH_PROVIDER=supabase): the existing page layout and controls,
 * backed by /api/contacts (server-side search, tag filter, keyset paging, exact totals). */

export type NativeContact = {
  id: string;
  firstName: string;
  lastName: string;
  name: string;
  email: string | null;
  phone: string | null;
  source: string;
  ownerUserId: string | null;
  ownerName: string | null;
  dnd: boolean;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export type ContactPage = { items: NativeContact[]; nextCursor: string | null; total: number };

type Detail = {
  contact: NativeContact;
  notes: { id: string; body: string; authorName: string | null; createdAt: string }[];
  opportunities: { id: string; title: string; valueCents: number; status: string }[];
  appointments: { id: string; startsAt: string; status: string }[];
};

type Form = { firstName: string; lastName: string; email: string; phone: string; source: string; ownerUserId: string; tags: string; dnd: boolean };

const EMPTY_FORM: Form = { firstName: "", lastName: "", email: "", phone: "", source: "manual", ownerUserId: "", tags: "", dnd: false };

function formOf(c: NativeContact): Form {
  return {
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email ?? "",
    phone: c.phone ?? "",
    source: c.source,
    ownerUserId: c.ownerUserId ?? "",
    tags: c.tags.join(", "),
    dnd: c.dnd,
  };
}

function payload(f: Form) {
  const blank = (v: string) => (v.trim() ? v.trim() : null);
  return {
    firstName: f.firstName.trim(),
    lastName: f.lastName.trim(),
    email: blank(f.email),
    phone: blank(f.phone),
    source: f.source.trim() || "manual",
    ownerUserId: f.ownerUserId || null,
    dnd: f.dnd,
    tags: f.tags.split(",").map((t) => t.trim()).filter(Boolean),
  };
}

export function NativeContacts({ initial, permissions }: { initial: ContactPage; permissions: string[] }) {
  const can = (p: string) => permissions.includes(p);
  const [page, setPage] = useState<ContactPage>(initial);
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [editing, setEditing] = useState<{ id: string | null; form: Form } | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [notice, setNotice] = useState("");
  const first = useRef(true);

  useEffect(() => {
    void loadMembers().then(setMembers);
  }, []);

  const search = useCallback(async (q: string, t: string, cursor?: string | null) => {
    const params = new URLSearchParams({ limit: "50" });
    if (q.trim()) params.set("q", q.trim());
    if (t.trim()) params.set("tag", t.trim());
    if (cursor) params.set("cursor", cursor);
    setBusy(true);
    const { body } = await api(`/api/contacts?${params}`);
    setBusy(false);
    if (!body.ok) {
      setError(failure(body, "Could not load contacts."));
      return;
    }
    setError("");
    const next = body as unknown as ContactPage;
    setPage((prev) => (cursor ? { ...next, items: [...prev.items, ...next.items] } : next));
  }, []);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const timer = setTimeout(() => void search(query, tag), 250);
    return () => clearTimeout(timer);
  }, [query, tag, search]);

  const openDetail = useCallback(async (id: string) => {
    const { body } = await api(`/api/contacts/${id}`);
    if (body.ok) setDetail(body as unknown as Detail);
    else setError(failure(body, "Could not open this contact."));
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setBusy(true);
    const { body } = await api(editing.id ? `/api/contacts/${editing.id}` : "/api/contacts", {
      method: editing.id ? "PATCH" : "POST",
      body: JSON.stringify(payload(editing.form)),
    });
    setBusy(false);
    if (!body.ok) {
      setError(failure(body, "Could not save the contact."));
      return;
    }
    setError("");
    const saved = body.contact as NativeContact;
    setNotice(editing.id ? `${saved.name} was updated.` : `${saved.name} was added.`);
    setEditing(null);
    await search(query, tag);
    if (detail && detail.contact.id === saved.id) await openDetail(saved.id);
  }

  async function remove(c: NativeContact) {
    if (!window.confirm(`Delete ${c.name}? The contact is hidden from every list.`)) return;
    const { body } = await api(`/api/contacts/${c.id}`, { method: "DELETE" });
    if (!body.ok) {
      setError(failure(body, "Could not delete the contact."));
      return;
    }
    setDetail(null);
    setNotice(`${c.name} was deleted.`);
    await search(query, tag);
  }

  async function addNote(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!detail) return;
    const field = e.currentTarget.elements.namedItem("note") as HTMLTextAreaElement;
    const { body } = await api(`/api/contacts/${detail.contact.id}/notes`, { method: "POST", body: JSON.stringify({ body: field.value }) });
    if (!body.ok) {
      setError(failure(body, "Could not add the note."));
      return;
    }
    field.value = "";
    await openDetail(detail.contact.id);
  }

  const filtering = Boolean(query.trim() || tag.trim());
  const rows = page.items.map((c) => [
    <button key={c.id} type="button" className="btn ghost sm" onClick={() => void openDetail(c.id)} aria-label={`Open ${c.name}`}>
      {c.name}
    </button>,
    c.phone ? "•••" : "—",
    c.email ? "•••" : "—",
    c.source || "—",
    when(c.updatedAt),
  ]);
  const set = (key: keyof Form) => (e: { target: { value: string } }) =>
    setEditing((s) => (s ? { ...s, form: { ...s.form, [key]: e.target.value } } : s));

  return (
    <AppShell>
      <PageHead title="Contacts" description={copy.sourceShort} />

      <StatusBanner>
        {page.total === 0 && !filtering
          ? copy.bannerWaiting("contacts")
          : `${page.total} contact(s) ${filtering ? "match" : "in this workspace"}. Phone/email masked in this view.`}
      </StatusBanner>
      {error ? <div className="banner error" role="alert">{error}</div> : null}
      {notice ? <div className="banner" role="status">{notice}</div> : null}

      <div className="grid grid-2" style={{ margin: "0 0 1.1rem" }}>
        <div>
          <label htmlFor="contact-search">Search contacts</label>
          <input id="contact-search" type="search" placeholder="Name, email, or phone" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div>
          <label htmlFor="contact-tag">Tag</label>
          <input id="contact-tag" type="search" placeholder="Any tag" value={tag} onChange={(e) => setTag(e.target.value)} />
        </div>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>Search and tag filters apply to this workspace&apos;s contacts.</p>

      <Card
        title="All Contacts"
        action={
          can("contacts.write") ? (
            <Button size="sm" variant="secondary" onClick={() => setEditing({ id: null, form: EMPTY_FORM })}>
              Add a contact
            </Button>
          ) : undefined
        }
      >
        <DataTable
          columns={["Name", "Phone", "Email", "Source", "Last Activity"]}
          rows={rows}
          emptyTitle={filtering ? "No matching contacts" : "No contacts yet"}
          emptyNote={filtering ? "Try a different search or clear the tag filter." : "Contacts added to this workspace appear here."}
        />
        {page.items.length ? (
          <p className="muted" style={{ marginBottom: 0 }}>
            Showing {page.items.length} of {page.total}.{" "}
            {page.nextCursor ? (
              <button type="button" className="btn secondary sm" disabled={busy} onClick={() => void search(query, tag, page.nextCursor)}>
                Load more
              </button>
            ) : null}
          </p>
        ) : null}
      </Card>

      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title={editing?.id ? "Edit contact" : "Add a contact"}>
        {editing ? (
          <form onSubmit={save} aria-label="Contact">
            <div className="grid grid-2">
              <div>
                <label htmlFor="c-first">First name</label>
                <input id="c-first" value={editing.form.firstName} onChange={set("firstName")} maxLength={100} />
              </div>
              <div>
                <label htmlFor="c-last">Last name</label>
                <input id="c-last" value={editing.form.lastName} onChange={set("lastName")} maxLength={100} />
              </div>
            </div>
            <label htmlFor="c-email">Email</label>
            <input id="c-email" type="email" value={editing.form.email} onChange={set("email")} />
            <label htmlFor="c-phone">Phone</label>
            <input id="c-phone" type="tel" value={editing.form.phone} onChange={set("phone")} />
            <label htmlFor="c-source">Source</label>
            <input id="c-source" value={editing.form.source} onChange={set("source")} maxLength={60} />
            <label htmlFor="c-owner">Owner</label>
            <select id="c-owner" value={editing.form.ownerUserId} onChange={set("ownerUserId")}>
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>{m.name || m.email}</option>
              ))}
            </select>
            <label htmlFor="c-tags">Tags (comma separated)</label>
            <input id="c-tags" value={editing.form.tags} onChange={set("tags")} />
            <label className="check">
              <input type="checkbox" checked={editing.form.dnd} onChange={(e) => setEditing((s) => (s ? { ...s, form: { ...s.form, dnd: e.target.checked } } : s))} />
              <span>Do not contact</span>
            </label>
            <div style={{ marginTop: "0.8rem" }}>
              <Button type="submit" disabled={busy}>{editing.id ? "Save contact" : "Add contact"}</Button>
            </div>
          </form>
        ) : null}
      </Modal>

      <Modal open={Boolean(detail) && !editing} onClose={() => setDetail(null)} title={detail?.contact.name ?? "Contact"}>
        {detail ? (
          <div>
            <p style={{ marginTop: 0 }}>
              {detail.contact.email ?? "No email"} · {detail.contact.phone ?? "No phone"}
              {detail.contact.dnd ? " · Do not contact" : ""}
            </p>
            <p className="muted">
              Source {detail.contact.source} · Owner {detail.contact.ownerName ?? "unassigned"}
              {detail.contact.tags.length ? ` · Tags: ${detail.contact.tags.join(", ")}` : ""}
            </p>
            <p className="muted">
              {detail.opportunities.length} opportunit{detail.opportunities.length === 1 ? "y" : "ies"} · {detail.appointments.length} appointment(s)
            </p>
            <div className="quick-actions">
              {can("contacts.write") ? (
                <Button size="sm" variant="secondary" onClick={() => setEditing({ id: detail.contact.id, form: formOf(detail.contact) })}>
                  Edit contact
                </Button>
              ) : null}
              {can("contacts.delete") ? (
                <Button size="sm" variant="ghost" onClick={() => void remove(detail.contact)}>
                  Delete contact
                </Button>
              ) : null}
            </div>
            <h4>Notes</h4>
            {detail.notes.length === 0 ? <EmptyState title="No notes yet" /> : (
              <ul style={{ paddingLeft: "1.1rem" }}>
                {detail.notes.map((n) => (
                  <li key={n.id}>
                    {n.body} <span className="muted">— {n.authorName ?? "Team member"}, {when(n.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
            {can("contacts.write") ? (
              <form onSubmit={addNote} aria-label="Add a note">
                <label htmlFor="c-note">Add a note</label>
                <textarea id="c-note" name="note" rows={3} maxLength={10000} required />
                <div style={{ marginTop: "0.5rem" }}>
                  <Button type="submit" size="sm">Save note</Button>
                </div>
              </form>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </AppShell>
  );
}
