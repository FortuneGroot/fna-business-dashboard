import { NextResponse } from "next/server";
import { getSyncStore } from "@/lib/sync";

export const dynamic = "force-dynamic";

export async function GET() {
  const store = getSyncStore();
  const appointments = await store.listAppointments();
  const summary = await store.summary();
  return NextResponse.json({
    ok: true,
    source: "sync-store",
    storageMode: store.storageMode,
    appointments: appointments.map((a) => ({
      id: a.externalAppointmentId,
      contactId: a.contactId || "—",
      calendarId: a.calendarId || "—",
      calendarName: a.calendarName || "—",
      status: a.status || "—",
      start: a.start || "—",
      end: a.end || "—",
      timezone: a.timezone || "—",
      assignedUser: a.assignedUser || "—",
      updatedAt: a.updatedAt,
    })),
    waitingForSync: summary.waitingForSync,
  });
}
