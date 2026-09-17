import { NextResponse } from "next/server";
import { getSyncStore } from "@/lib/sync";

export const dynamic = "force-dynamic";

export async function GET() {
  const store = getSyncStore();
  return NextResponse.json({
    ok: true,
    source: "sync-store",
    contacts: store.listContacts().map((c) => ({
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
    waitingForSync: store.summary().waitingForSync,
  });
}
