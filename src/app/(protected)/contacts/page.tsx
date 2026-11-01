import { getPageData } from "@/lib/data";
import { ContactsClient } from "./ContactsClient";

export const dynamic = "force-dynamic";

export default async function ContactsPage() {
  const { reader, native } = await getPageData();
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
