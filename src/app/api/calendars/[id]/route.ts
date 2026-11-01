import type { NextRequest } from "next/server";
import { nativeApi, parseBody, parseId } from "@/lib/api/native";
import { calendarPatch, saveCalendar } from "@/lib/native/calendars";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return nativeApi(req, { permission: "calendar.configure" }, async (scope) => {
    const calendarId = parseId(id);
    const input = await parseBody(req, calendarPatch);
    return { calendar: await saveCalendar(scope, calendarId, input) };
  });
}
