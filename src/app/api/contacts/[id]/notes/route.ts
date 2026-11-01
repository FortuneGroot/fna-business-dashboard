import type { NextRequest } from "next/server";
import { nativeApi, parseBody, parseId } from "@/lib/api/native";
import { addContactNote, noteInput } from "@/lib/native/contacts";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return nativeApi(req, { permission: "contacts.write" }, async (scope) => {
    const contactId = parseId(id);
    const { body } = await parseBody(req, noteInput);
    return { note: await addContactNote(scope, contactId, body) };
  });
}
