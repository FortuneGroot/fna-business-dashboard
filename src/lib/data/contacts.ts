import "server-only";
import type { ContactRecord } from "@/lib/data/records";
import { contactRecord, type NativeContactRow } from "./dashboard-adapters";
import { displayNames, fromWorkspace, LIST_LIMIT, rows, type DataScope } from "./query";

const COLUMNS =
  "id, first_name, last_name, email, phone, source, owner_user_id, created_at, updated_at, contact_tags(tag)";

export async function listContacts(scope: DataScope): Promise<ContactRecord[]> {
  const data = await rows<NativeContactRow>(
    fromWorkspace(scope, "contacts", COLUMNS)
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .limit(LIST_LIMIT),
    "contacts"
  );
  const names = await displayNames(scope, data.map((c) => c.owner_user_id));
  return data.map((c) => contactRecord(c, names));
}
