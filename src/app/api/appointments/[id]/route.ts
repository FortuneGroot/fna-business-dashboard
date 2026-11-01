import type { NextRequest } from "next/server";
import { nativeApi, parseBody, parseId } from "@/lib/api/native";
import { appointmentPatch, updateAppointment } from "@/lib/native/calendars";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return nativeApi(req, { permission: "appointments.write" }, async (scope) => {
    const appointmentId = parseId(id);
    const input = await parseBody(req, appointmentPatch);
    return { appointment: await updateAppointment(scope, appointmentId, input) };
  });
}
