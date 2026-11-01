import type { NextRequest } from "next/server";
import { nativeApi, parseBody, parseId } from "@/lib/api/native";
import { availabilityInput, replaceAvailability } from "@/lib/native/calendars";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return nativeApi(req, { permission: "calendar.configure" }, async (scope) => {
    const calendarId = parseId(id);
    const { rules } = await parseBody(req, availabilityInput);
    return { rules: await replaceAvailability(scope, calendarId, rules) };
  });
}
