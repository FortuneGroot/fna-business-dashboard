import type { NextRequest } from "next/server";
import { nativeApi, parseBody } from "@/lib/api/native";
import { calendarCreate, listCalendars, saveCalendar } from "@/lib/native/calendars";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return nativeApi(req, { permission: "calendar.read" }, async (scope) => ({ items: await listCalendars(scope) }));
}

export async function POST(req: NextRequest) {
  return nativeApi(req, { permission: "calendar.configure" }, async (scope) => {
    const input = await parseBody(req, calendarCreate);
    return { calendar: await saveCalendar(scope, null, input) };
  });
}
