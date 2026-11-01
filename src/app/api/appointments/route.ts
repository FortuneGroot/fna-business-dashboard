import type { NextRequest } from "next/server";
import { nativeApi, parseBody, parseQuery } from "@/lib/api/native";
import { appointmentCreate, appointmentListQuery, createAppointment, listAppointments } from "@/lib/native/calendars";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return nativeApi(req, { permission: "calendar.read" }, async (scope) => listAppointments(scope, parseQuery(req, appointmentListQuery)));
}

/** 409 `overlap` when the calendar already has a booked or confirmed appointment in that slot. */
export async function POST(req: NextRequest) {
  return nativeApi(req, { permission: "appointments.write" }, async (scope) => {
    const input = await parseBody(req, appointmentCreate);
    return { appointment: await createAppointment(scope, input) };
  });
}
