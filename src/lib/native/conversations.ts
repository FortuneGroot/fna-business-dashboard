import "server-only";
import { z } from "zod";
import { check, notFound, pageQuery, uuid } from "@/lib/api/native";
import { activeWorkspaceId, displayNames, type DataScope } from "@/lib/data/query";
import { afterKeyset, contactNames, decodeKeyset, nextKeyset } from "./records";

export type ConversationItem = {
  id: string;
  contactId: string;
  contactName: string | null;
  channel: string;
  status: "open" | "closed";
  assignedUserId: string | null;
  assignedName: string | null;
  lastMessageAt: string | null;
  createdAt: string;
};

export type MessageItem = {
  id: string;
  direction: "inbound" | "outbound" | "internal";
  body: string;
  authorUserId: string | null;
  authorName: string | null;
  deliveryStatus: "not_sent" | "queued" | "sent" | "delivered" | "failed";
  createdAt: string;
};

type RawConversation = {
  id: string;
  contact_id: string;
  channel: ConversationItem["channel"];
  status: ConversationItem["status"];
  assigned_user_id: string | null;
  last_message_at: string | null;
  created_at: string;
};
type RawMessage = {
  id: string;
  direction: MessageItem["direction"];
  body: string;
  author_user_id: string | null;
  delivery_status: MessageItem["deliveryStatus"];
  created_at: string;
};

const CONVERSATION_COLUMNS = "id, contact_id, channel, status, assigned_user_id, last_message_at, created_at";
const MESSAGE_COLUMNS = "id, direction, body, author_user_id, delivery_status, created_at";

export const conversationListQuery = z.strictObject({
  status: z.enum(["open", "closed"]).optional(),
  assignedUserId: uuid.optional(),
  ...pageQuery,
});
export const messageListQuery = z.strictObject({ ...pageQuery });
export const conversationNote = z.strictObject({ body: z.string().trim().min(1, "Write a note").max(20000) });

type ListQuery = z.infer<typeof conversationListQuery>;

function filtered(scope: DataScope, query: ListQuery, select: string, options?: { count: "exact"; head: true }) {
  let q = scope.supabase.from("conversations").select(select, options).eq("workspace_id", activeWorkspaceId(scope));
  if (query.status) q = q.eq("status", query.status);
  if (query.assignedUserId) q = q.eq("assigned_user_id", query.assignedUserId.toLowerCase());
  return q;
}

/** GET /api/conversations: newest first, keyset-paginated, exact total for the filters. */
export async function listConversations(scope: DataScope, query: ListQuery) {
  const after = decodeKeyset(query.cursor);
  let page = filtered(scope, query, CONVERSATION_COLUMNS);
  if (after) page = page.or(afterKeyset("created_at", after));
  const [rows, count] = await Promise.all([
    page.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(query.limit + 1),
    filtered(scope, query, "id", { count: "exact", head: true }),
  ]);
  const data = (check(rows) as unknown as RawConversation[] | null) ?? [];
  check(count);
  const pageRows = data.slice(0, query.limit);
  const [names, contacts] = await Promise.all([
    displayNames(scope, pageRows.map((r) => r.assigned_user_id)),
    contactNames(scope, pageRows.map((r) => r.contact_id)),
  ]);
  return {
    items: pageRows.map<ConversationItem>((r) => ({
      id: r.id,
      contactId: r.contact_id,
      contactName: contacts.get(r.contact_id) ?? null,
      channel: r.channel,
      status: r.status,
      assignedUserId: r.assigned_user_id,
      assignedName: r.assigned_user_id ? names.get(r.assigned_user_id) ?? null : null,
      lastMessageAt: r.last_message_at,
      createdAt: r.created_at,
    })),
    nextCursor: nextKeyset(data, query.limit, (r) => r.created_at),
    total: count.count ?? 0,
  };
}

async function requireConversation(scope: DataScope, id: string): Promise<void> {
  const row = check(
    await scope.supabase.from("conversations").select("id").eq("workspace_id", activeWorkspaceId(scope)).eq("id", id).maybeSingle()
  );
  if (!row) throw notFound();
}

async function messageItems(scope: DataScope, rows: RawMessage[]): Promise<MessageItem[]> {
  const names = await displayNames(scope, rows.map((r) => r.author_user_id));
  return rows.map((r) => ({
    id: r.id,
    direction: r.direction,
    body: r.body,
    authorUserId: r.author_user_id,
    authorName: r.author_user_id ? names.get(r.author_user_id) ?? null : null,
    deliveryStatus: r.delivery_status,
    createdAt: r.created_at,
  }));
}

/** GET /api/conversations/[id]/messages: newest first, keyset-paginated. */
export async function listMessages(scope: DataScope, id: string, query: z.infer<typeof messageListQuery>) {
  await requireConversation(scope, id);
  const after = decodeKeyset(query.cursor);
  let q = scope.supabase.from("messages").select(MESSAGE_COLUMNS).eq("workspace_id", activeWorkspaceId(scope)).eq("conversation_id", id);
  if (after) q = q.or(afterKeyset("created_at", after));
  const data = (check(await q.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(query.limit + 1)) as RawMessage[] | null) ?? [];
  return { items: await messageItems(scope, data.slice(0, query.limit)), nextCursor: nextKeyset(data, query.limit, (r) => r.created_at) };
}

/**
 * POST /api/conversations/[id]/notes: an internal note. The database allows clients to insert only
 * `direction = 'internal'` with `delivery_status = 'not_sent'`, and nothing in the app sends messages.
 */
export async function addConversationNote(scope: DataScope, id: string, body: string): Promise<MessageItem> {
  await requireConversation(scope, id);
  const data = check(
    await scope.supabase
      .from("messages")
      .insert({ workspace_id: activeWorkspaceId(scope), conversation_id: id, direction: "internal", body })
      .select(MESSAGE_COLUMNS)
      .single()
  ) as RawMessage;
  return (await messageItems(scope, [data]))[0];
}
