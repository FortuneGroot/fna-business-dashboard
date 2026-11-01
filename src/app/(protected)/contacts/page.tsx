import { getPageData, getPageScope } from "@/lib/data";
import { NativeContacts } from "@/components/records/NativeContacts";
import { listContacts } from "@/lib/native/contacts";
import { ContactsClient } from "./ContactsClient";

export const dynamic = "force-dynamic";

export default async function ContactsPage() {
  const { reader, native } = await getPageData();
  if (native) {
    const scope = await getPageScope();
    const initial = await listContacts(scope, { limit: 50 });
    return <NativeContacts initial={initial} permissions={scope.ctx.permissions} />;
  }
  const contacts = await reader.listContacts();
  const waiting = contacts.length === 0;
  const rows = contacts.map((c) => ({
    id: c.externalContactId,
    name:
      c.displayName ||
      [c.firstName, c.lastName].filter(Boolean).join(" ") ||
      c.externalContactId,
    hasPhone: Boolean(c.phone),
    hasEmail: Boolean(c.email),
    source: c.source || "—",
    updatedAt: c.updatedAt ? c.updatedAt.slice(0, 16).replace("T", " ") : "—",
  }));

  return <ContactsClient contacts={rows} waiting={waiting} native={native} />;
}
