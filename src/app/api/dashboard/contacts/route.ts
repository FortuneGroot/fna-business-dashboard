import { NextRequest } from "next/server";
import { readApi } from "@/lib/data/api";
import { contactRow, type ContactsResponse } from "@/lib/data/dashboard-api";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return readApi(req, "contacts.read", async ({ reader }): Promise<ContactsResponse> => {
    const [contacts, waitingForSync] = await Promise.all([reader.listContacts(), reader.waitingForSync()]);
    return {
      ok: true,
      source: reader.source,
      storageMode: reader.storageMode,
      contacts: contacts.map(contactRow),
      waitingForSync,
    };
  });
}
