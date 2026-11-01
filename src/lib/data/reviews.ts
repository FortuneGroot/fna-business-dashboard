import "server-only";
import type { ReviewEventRecord } from "@/lib/data/records";
import { reviewEventRecord, type NativeReviewRow } from "./dashboard-adapters";
import { fromWorkspace, rows, type DataScope } from "./query";

export async function listReviewEvents(scope: DataScope, limit = 100): Promise<ReviewEventRecord[]> {
  const data = await rows<NativeReviewRow>(
    fromWorkspace(scope, "reviews", "id, contact_id, rating, received_at")
      .order("received_at", { ascending: false })
      .limit(limit),
    "reviews"
  );
  return data.map(reviewEventRecord);
}
