import "server-only";
import { z } from "zod";
import { check, pageQuery } from "@/lib/api/native";
import { activeWorkspaceId, type DataScope } from "@/lib/data/query";
import { afterKeyset, contactNames, decodeKeyset, nextKeyset } from "./records";

export type ReviewItem = {
  id: string;
  contactId: string | null;
  contactName: string | null;
  source: string;
  rating: number | null;
  body: string;
  receivedAt: string;
};

type RawReview = { id: string; contact_id: string | null; source: string; rating: number | null; body: string; received_at: string };

export const reviewListQuery = z.strictObject({ ...pageQuery });

/** GET /api/reviews: newest first by received time, keyset-paginated, exact total. */
export async function listReviews(scope: DataScope, query: z.infer<typeof reviewListQuery>) {
  const ws = activeWorkspaceId(scope);
  const after = decodeKeyset(query.cursor);
  let page = scope.supabase.from("reviews").select("id, contact_id, source, rating, body, received_at").eq("workspace_id", ws);
  if (after) page = page.or(afterKeyset("received_at", after));
  const [rows, count] = await Promise.all([
    page.order("received_at", { ascending: false }).order("id", { ascending: false }).limit(query.limit + 1),
    scope.supabase.from("reviews").select("id", { count: "exact", head: true }).eq("workspace_id", ws),
  ]);
  const data = (check(rows) as RawReview[] | null) ?? [];
  check(count);
  const pageRows = data.slice(0, query.limit);
  const contacts = await contactNames(scope, pageRows.map((r) => r.contact_id));
  return {
    items: pageRows.map<ReviewItem>((r) => ({
      id: r.id,
      contactId: r.contact_id,
      contactName: r.contact_id ? contacts.get(r.contact_id) ?? null : null,
      source: r.source,
      rating: r.rating,
      body: r.body,
      receivedAt: r.received_at,
    })),
    nextCursor: nextKeyset(data, query.limit, (r) => r.received_at),
    total: count.count ?? 0,
  };
}
