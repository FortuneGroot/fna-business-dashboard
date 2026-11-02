import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { asUser, buildWorld, createContact, rows, rpc, type World } from "./harness";

// M25: appointment rules hold for every writer (the API and direct Data API calls), checked on the row
// as it will be stored, so two edits that each look fine cannot combine into a forbidden result.

let w: World;
let calendar = "";
let contact = "";

before(async () => {
  w = await buildWorld();
  contact = await createContact(w.db, w.ownerA, w.wsA, "Rules contact");
  calendar = await asUser(w.db, w.ownerA, (q) =>
    rpc<string>(q, "save_calendar", [null, JSON.stringify({ name: "Rules cal", slug: "rules-cal", duration_minutes: 30 }), null]));
});

after(async () => {
  await w.db.close();
});

const book = (start: string, end: string) =>
  asUser(w.db, w.employeeA, async (q) =>
    (await rows<{ id: string }>(q,
      "insert into public.appointments (workspace_id, calendar_id, contact_id, starts_at, ends_at) values ($1, $2, $3, $4, $5) returning id",
      [w.wsA, calendar, contact, start, end]))[0].id);
const update = (id: string, set: string, params: unknown[] = []) =>
  asUser(w.db, w.employeeA, (q) => rows(q, `update public.appointments set ${set} where id = $1`, [id, ...params]));
const setActive = (active: boolean) =>
  asUser(w.db, w.ownerA, (q) => rpc(q, "save_calendar", [calendar, JSON.stringify({ active }), null]));

describe("M25: appointment rules in the database", () => {
  test("no appointment longer than 24 hours, including when two edits combine", async () => {
    await assert.rejects(book("2031-01-01T00:00Z", "2031-01-02T00:01Z"), /appointment_too_long/);
    const id = await book("2031-01-05T10:00Z", "2031-01-05T11:00Z");
    await update(id, "starts_at = '2031-01-04T15:00Z'");
    await assert.rejects(update(id, "ends_at = '2031-01-06T09:00Z'"), /appointment_too_long/,
      "the second edit is checked against the stored row, not the one its author read");
  });

  test("a deactivated calendar takes no new, moved or revived bookings; existing ones can still be confirmed or cancelled", async () => {
    const kept = await book("2031-02-01T10:00Z", "2031-02-01T10:30Z");
    const revived = await book("2031-02-02T10:00Z", "2031-02-02T10:30Z");
    await update(revived, "status = 'cancelled'");
    await setActive(false);
    try {
      await assert.rejects(book("2031-02-03T10:00Z", "2031-02-03T10:30Z"), /calendar_inactive/);
      await assert.rejects(update(kept, "starts_at = '2031-02-01T12:00Z', ends_at = '2031-02-01T12:30Z'"), /calendar_inactive/);
      await assert.rejects(update(revived, "status = 'booked'"), /calendar_inactive/);
      await update(kept, "status = 'confirmed'");
      await update(kept, "status = 'cancelled'");
    } finally {
      await setActive(true);
    }
    await update(revived, "status = 'booked'");
  });
});
