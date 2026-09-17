import { NextResponse } from "next/server";
import { getSyncStore } from "@/lib/sync";

export const dynamic = "force-dynamic";

export async function GET() {
  const store = getSyncStore();
  const contacts = await store.listContacts();
  const summary = await store.summary();
  return NextResponse.json({
    ok: true,
    source: "sync-store",
    storageMode: store.storageMode,
    contacts: contacts.map((c) => ({
      id: c.externalContactId,
      displayName: c.displayName || [c.firstName, c.lastName].filter(Boolean).join(" ") || "—",
      email: c.email ? "[redacted]" : undefined,
      phone: c.phone ? "[redacted]" : undefined,
      hasEmail: Boolean(c.email),
      hasPhone: Boolean(c.phone),
      source: c.source || "—",
      tags: c.tags,
      assignedUser: c.assignedUser || "—",
      updatedAt: c.updatedAt,
    })),
    waitingForSync: summary.waitingForSync,
  });
}
