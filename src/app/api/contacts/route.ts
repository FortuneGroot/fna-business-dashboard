import type { NextRequest } from "next/server";
import { nativeApi, parseBody, parseQuery } from "@/lib/api/native";
import { contactCreate, contactListQuery, listContacts, saveContact } from "@/lib/native/contacts";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return nativeApi(req, { permission: "contacts.read" }, async (scope) => listContacts(scope, parseQuery(req, contactListQuery)));
}

export async function POST(req: NextRequest) {
  return nativeApi(req, { permission: "contacts.write" }, async (scope) => {
    const input = await parseBody(req, contactCreate);
    return { contact: await saveContact(scope, null, input) };
  });
}
