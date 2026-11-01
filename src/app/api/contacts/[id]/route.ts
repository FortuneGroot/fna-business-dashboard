import type { NextRequest } from "next/server";
import { nativeApi, parseBody, parseId } from "@/lib/api/native";
import { contactPatch, deleteContact, getContactDetail, saveContact } from "@/lib/native/contacts";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return nativeApi(req, { permission: "contacts.read" }, async (scope) => getContactDetail(scope, parseId(id)));
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return nativeApi(req, { permission: "contacts.write" }, async (scope) => {
    const contactId = parseId(id);
    const input = await parseBody(req, contactPatch);
    return { contact: await saveContact(scope, contactId, input) };
  });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return nativeApi(req, { permission: "contacts.delete" }, async (scope) => {
    await deleteContact(scope, parseId(id));
    return {};
  });
}
