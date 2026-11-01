import { NextRequest } from "next/server";
import { readApi } from "@/lib/data/api";
import { appointmentRow, type AppointmentsResponse } from "@/lib/data/dashboard-api";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return readApi(req, "calendar.read", async ({ reader }): Promise<AppointmentsResponse> => {
    const [appointments, waitingForSync] = await Promise.all([reader.listAppointments(), reader.waitingForSync()]);
    return {
      ok: true,
      source: reader.source,
      storageMode: reader.storageMode,
      appointments: appointments.map(appointmentRow),
      waitingForSync,
    };
  });
}
