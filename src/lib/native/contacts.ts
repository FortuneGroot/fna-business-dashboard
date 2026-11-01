import "server-only";
import { z } from "zod";
import { ApiError, check, conflict, invalid, notFound, pageQuery, uuid } from "@/lib/api/native";
import { activeWorkspaceId, displayNames, type DataScope } from "@/lib/data/query";
import { afterKeyset, contactNames, decodeKeyset, memberField, nextKeyset, nonEmpty, searchWords } from "./records";

export type ContactItem = {
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

type RawContact = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  source: string;
  owner_user_id: string | null;
  dnd: boolean;
  created_at: string;
  updated_at: string;
};

const COLUMNS = "id, first_name, last_name, email, phone, source, owner_user_id, dnd, created_at, updated_at";

const name = z.string().trim().max(100, "Use at most 100 characters");
const email = z.string().trim().toLowerCase().max(254).pipe(z.email({ message: "Enter a valid email address" }));
const phone = z.string().trim().regex(/^\+?[0-9 ().-]{7,32}$/, "Enter a valid phone number");
const tag = z
  .string()
  .trim()
  .min(1, "Tags cannot be empty")
  .max(60, "Use at most 60 characters per tag")
  .regex(/^[^\p{Cc},]+$/u, "Tags cannot contain commas or control characters");
const tags = z
  .array(tag)
  .max(20, "Use at most 20 tags")
  .transform((list) => {
    const seen = new Set<string>();
    return list.filter((t) => (seen.has(t.toLowerCase()) ? false : (seen.add(t.toLowerCase()), true)));
  });

const fields = {
  firstName: name.optional(),
  lastName: name.optional(),
  email: email.nullable().optional(),
  phone: phone.nullable().optional(),
  source: z.string().trim().min(1).max(60).optional(),
  ownerUserId: uuid.nullable().optional(),
  dnd: z.boolean().optional(),
  tags: tags.optional(),
};

export const contactCreate = z
  .strictObject(fields)
  .refine((c) => Boolean(c.firstName || c.lastName || c.email || c.phone), {
    message: "Provide a name, email, or phone",
    path: ["firstName"],
  });

export const contactPatch = z.strictObject(fields).refine(nonEmpty, { message: "Provide at least one field", path: ["body"] });

export const contactListQuery = z.strictObject({
  q: z.string().trim().max(100).optional(),
  tag: tag.optional(),
  ownerUserId: uuid.optional(),
  ...pageQuery,
});

export const noteInput = z.strictObject({ body: z.string().trim().min(1, "Write a note").max(10000) });

const COLUMN: Record<string, string> = {
  firstName: "first_name",
  lastName: "last_name",
  email: "email",
  phone: "phone",
  source: "source",
  ownerUserId: "owner_user_id",
  dnd: "dnd",
};

async function tagsFor(scope: DataScope, ids: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (!ids.length) return map;
  const data = check(
    await scope.supabase.from("contact_tags").select("contact_id, tag").eq("workspace_id", activeWorkspaceId(scope)).in("contact_id", ids)
  ) as { contact_id: string; tag: string }[] | null;
  for (const row of data ?? []) map.set(row.contact_id, [...(map.get(row.contact_id) ?? []), row.tag]);
  for (const list of map.values()) list.sort((a, b) => a.localeCompare(b));
  return map;
}

async function toItems(scope: DataScope, rows: RawContact[]): Promise<ContactItem[]> {
  const [names, tagMap] = await Promise.all([
    displayNames(scope, rows.map((r) => r.owner_user_id)),
    tagsFor(scope, rows.map((r) => r.id)),
  ]);
  return rows.map((r) => ({
    id: r.id,
    firstName: r.first_name,
    lastName: r.last_name,
    name: `${r.first_name} ${r.last_name}`.trim() || r.email || r.phone || "Unnamed contact",
    email: r.email,
    phone: r.phone,
    source: r.source,
    ownerUserId: r.owner_user_id,
    ownerName: r.owner_user_id ? names.get(r.owner_user_id) ?? null : null,
    dnd: r.dnd,
    tags: tagMap.get(r.id) ?? [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

type ListQuery = z.infer<typeof contactListQuery>;

/**
 * Filters shared by the page query and its count; `extra` (the cursor) applies to the page only.
 * Every word must match one of the name/email/phone columns; all conditions go into one `or=(and(…))`.
 */
function filtered(scope: DataScope, query: ListQuery, select: string, extra: string[], options?: { count: "exact"; head: true }) {
  let q = scope.supabase
    .from("contacts")
    .select(query.tag ? `${select}, contact_tags!inner(tag)` : select, options)
    .eq("workspace_id", activeWorkspaceId(scope))
    .is("deleted_at", null);
  if (query.tag) q = q.eq("contact_tags.tag", query.tag);
  if (query.ownerUserId) q = q.eq("owner_user_id", query.ownerUserId.toLowerCase());
  const conditions = searchWords(query.q).map(
    (word) => `or(${["first_name", "last_name", "email", "phone"].map((c) => `${c}.ilike.*${word}*`).join(",")})`
  );
  conditions.push(...extra);
  if (conditions.length) q = q.or(`and(${conditions.join(",")})`);
  return q;
}

/** GET /api/contacts: newest first, keyset-paginated, with the exact total for the filters. */
export async function listContacts(
  scope: DataScope,
  query: ListQuery
): Promise<{ items: ContactItem[]; nextCursor: string | null; total: number }> {
  const after = decodeKeyset(query.cursor);
  const page = filtered(scope, query, COLUMNS, after ? [`or(${afterKeyset("created_at", after)})`] : []);
  const [rows, count] = await Promise.all([
    page.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(query.limit + 1),
    filtered(scope, query, "id", [], { count: "exact", head: true }),
  ]);
  const data = (check(rows) as unknown as RawContact[] | null) ?? [];
  check(count);
  const pageRows = data.slice(0, query.limit);
  return {
    items: await toItems(scope, pageRows),
    nextCursor: nextKeyset(data, query.limit, (r) => r.created_at),
    total: count.count ?? 0,
  };
}

async function contactRow(scope: DataScope, id: string): Promise<RawContact> {
  const data = check(
    await scope.supabase.from("contacts").select(COLUMNS).eq("workspace_id", activeWorkspaceId(scope)).eq("id", id).is("deleted_at", null).maybeSingle()
  ) as RawContact | null;
  if (!data) throw notFound();
  return data;
}

export async function getContactItem(scope: DataScope, id: string): Promise<ContactItem> {
  return (await toItems(scope, [await contactRow(scope, id)]))[0];
}

/** GET /api/contacts/[id]: the contact with its notes, open records, and appointments. */
export async function getContactDetail(scope: DataScope, id: string) {
  const contact = await getContactItem(scope, id);
  const ws = activeWorkspaceId(scope);
  const [notes, opportunities, appointments] = await Promise.all([
    scope.supabase.from("contact_notes").select("id, body, author_id, created_at").eq("workspace_id", ws).eq("contact_id", id)
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(100),
    scope.supabase.from("opportunities").select("id, title, value_cents, currency, status, stage_id, created_at").eq("workspace_id", ws)
      .eq("contact_id", id).is("deleted_at", null).order("created_at", { ascending: false }).limit(100),
    scope.supabase.from("appointments").select("id, calendar_id, starts_at, ends_at, status").eq("workspace_id", ws)
      .eq("contact_id", id).is("deleted_at", null).order("starts_at", { ascending: false }).limit(100),
  ]);
  const noteRows = (check(notes) as { id: string; body: string; author_id: string; created_at: string }[] | null) ?? [];
  const oppRows = (check(opportunities) as { id: string; title: string; value_cents: number; currency: string; status: string; stage_id: string; created_at: string }[] | null) ?? [];
  const apptRows = (check(appointments) as { id: string; calendar_id: string; starts_at: string; ends_at: string; status: string }[] | null) ?? [];
  const authors = await displayNames(scope, noteRows.map((n) => n.author_id));
  return {
    contact,
    tags: contact.tags,
    notes: noteRows.map((n) => ({ id: n.id, body: n.body, authorUserId: n.author_id, authorName: authors.get(n.author_id) ?? null, createdAt: n.created_at })),
    opportunities: oppRows.map((o) => ({
      id: o.id, title: o.title, valueCents: Number(o.value_cents), currency: o.currency, status: o.status, stageId: o.stage_id, createdAt: o.created_at,
    })),
    appointments: apptRows.map((a) => ({ id: a.id, calendarId: a.calendar_id, startsAt: a.starts_at, endsAt: a.ends_at, status: a.status })),
  };
}

function values(input: z.infer<typeof contactPatch>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(COLUMN)) {
    const v = (input as Record<string, unknown>)[key];
    if (v !== undefined) out[column] = typeof v === "string" && column === "owner_user_id" ? v.toLowerCase() : v;
  }
  return out;
}

function saveFailure(error: { message?: string; code?: string } | null): ApiError | null {
  if (!error) return null;
  if (error.code === "23505") return conflict("A contact with this email already exists in this workspace", "duplicate_email");
  if (error.code === "23503") return memberField("ownerUserId");
  if (error.code === "23514") return invalid({ firstName: "Provide a name, email, or phone" });
  return null;
}

/** POST / PATCH: one transaction through rpc save_contact (contact fields and tags together). */
export async function saveContact(scope: DataScope, id: string | null, input: z.infer<typeof contactPatch>): Promise<ContactItem> {
  const res = await scope.supabase.rpc("save_contact", {
    p_id: id,
    p_values: values(input),
    p_tags: input.tags ?? null,
  });
  const mapped = saveFailure(res.error);
  if (mapped) throw mapped;
  const savedId = check(res) as string;
  return getContactItem(scope, savedId);
}

export async function deleteContact(scope: DataScope, id: string): Promise<void> {
  check(await scope.supabase.rpc("soft_delete_contact", { p_id: id }));
}

/** POST /api/contacts/[id]/notes: the author is stamped by the database. */
export async function addContactNote(scope: DataScope, id: string, body: string) {
  await contactRow(scope, id);
  const data = check(
    await scope.supabase
      .from("contact_notes")
      .insert({ workspace_id: activeWorkspaceId(scope), contact_id: id, body })
      .select("id, body, author_id, created_at")
      .single()
  ) as { id: string; body: string; author_id: string; created_at: string };
  const authors = await displayNames(scope, [data.author_id]);
  return { id: data.id, body: data.body, authorUserId: data.author_id, authorName: authors.get(data.author_id) ?? null, createdAt: data.created_at };
}

export { contactNames };
