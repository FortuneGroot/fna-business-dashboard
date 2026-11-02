import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type pg from "pg";
import { beginAs, requestAs, startRealPostgres, type RealPg, type RealUser } from "./realpg";

// Simultaneous bookings of one slot (the recorded intermittent 503): every loser must get the
// overlap error (23P01, mapped to 409), never a deadlock or another unmapped failure. Inserts go
// straight to public.appointments as the signed-in member, exactly as the app does through PostgREST.

const ROUNDS = 60;
const SESSIONS = 8;

let server: RealPg;
let admin: pg.Client;
let owner: RealUser;
let calendar = "";
let contact = "";

async function createUser(email: string, aal: "aal1" | "aal2" = "aal1"): Promise<RealUser> {
  const r = await admin.query<{ id: string }>("insert into auth.users (email) values ($1) returning id", [email]);
  return { id: r.rows[0].id, email, aal };
}

before(async () => {
  server = await startRealPostgres();
  admin = await server.connect();
  const platform = await createUser("booking-platform@example.test", "aal2");
  await admin.query("insert into public.platform_admins (user_id) values ($1)", [platform.id]);
  owner = await createUser("booking-owner@example.test");
  const c = await server.connect();
  try {
    const [prov] = await requestAs<{ r: { invite_token: string } }>(c, platform,
      "select public.platform_provision_workspace($1, $2, $3, $4) r",
      ["synthetic-booking", "Booking Race (synthetic)", "booking-race", owner.email]);
    await requestAs(c, owner, "select public.accept_invitation($1)", [prov.r.invite_token]);
    const [cal] = await requestAs<{ r: string }>(c, owner, "select public.save_calendar(null, $1::jsonb) r",
      [JSON.stringify({ name: "Chairs", slug: "chairs", duration_minutes: 60 })]);
    calendar = cal.r;
    const [ct] = await requestAs<{ id: string }>(c, owner,
      "insert into public.contacts (workspace_id, first_name, last_name) values (private.active_workspace_id(), 'Race', 'Customer') returning id");
    contact = ct.id;
  } finally {
    await c.end();
  }
});

after(async () => {
  await admin?.end().catch(() => {});
  await server?.stop();
});

/** Runs `rounds` rounds of SESSIONS simultaneous inserts of one slot; returns outcome counts. */
async function race(rounds: number, firstHour: number): Promise<Map<string, number>> {
  const codes = new Map<string, number>();
  const clients = await Promise.all(Array.from({ length: SESSIONS }, () => server.connect()));
  try {
    for (let round = 0; round < rounds; round++) {
      const start = new Date(Date.UTC(2032, 0, 1, 9) + (firstHour + round) * 3_600_000);
      const end = new Date(start.getTime() + 3_600_000);
      for (const c of clients) await beginAs(c, owner);
      const results = await Promise.all(clients.map((c) =>
        c.query(
          `insert into public.appointments (workspace_id, calendar_id, contact_id, starts_at, ends_at)
           values (private.active_workspace_id(), $1, $2, $3, $4)`, [calendar, contact, start.toISOString(), end.toISOString()])
          .then(async () => {
            await c.query("commit");
            return "ok";
          }, async (err: { code?: string }) => {
            await c.query("rollback");
            return err.code ?? "unknown";
          })));
      for (const r of results) codes.set(r, (codes.get(r) ?? 0) + 1);
      const booked = await admin.query<{ n: number }>(
        "select count(*)::int n from public.appointments where calendar_id = $1 and starts_at = $2", [calendar, start.toISOString()]);
      assert.equal(booked.rows[0].n, 1, `round ${round}: exactly one booking stored`);
    }
  } finally {
    await Promise.all(clients.map((c) => c.end().catch(() => {})));
  }
  return codes;
}

const summary = (codes: Map<string, number>) => [...codes].map(([k, v]) => `${k}=${v}`).join(" ");

describe("real PostgreSQL: simultaneous bookings of one slot", () => {
  test(`${ROUNDS} rounds of ${SESSIONS} simultaneous inserts: one booking each round, every loser 23P01 (no deadlock)`, async () => {
    const codes = await race(ROUNDS, 0);
    console.log(`booking race outcomes over ${ROUNDS * SESSIONS} attempts: ${summary(codes)}`);
    assert.equal(codes.get("ok"), ROUNDS, summary(codes));
    assert.equal(codes.get("23P01"), ROUNDS * (SESSIONS - 1), `every loser is an overlap refusal: ${summary(codes)}`);
  });

  test("20 rounds of 8 simultaneous reschedules into one slot: one move each round, every loser 23P01", async () => {
    const codes = new Map<string, number>();
    const clients = await Promise.all(Array.from({ length: SESSIONS }, () => server.connect()));
    try {
      for (let round = 0; round < 20; round++) {
        const base = Date.UTC(2033, 0, 1) + round * 86_400_000;
        const ids: string[] = [];
        for (let i = 0; i < SESSIONS; i++) {
          const r = await admin.query<{ id: string }>(
            `insert into public.appointments (workspace_id, calendar_id, contact_id, starts_at, ends_at)
             select workspace_id, id, $2, $3, $4 from public.calendars where id = $1 returning id`,
            [calendar, contact, new Date(base + (i + 1) * 3_600_000).toISOString(), new Date(base + (i + 2) * 3_600_000 - 1).toISOString()]);
          ids.push(r.rows[0].id);
        }
        const slot = [new Date(base + 12 * 3_600_000).toISOString(), new Date(base + 13 * 3_600_000).toISOString()];
        for (const c of clients) await beginAs(c, owner);
        const results = await Promise.all(clients.map((c, i) =>
          c.query("update public.appointments set starts_at = $2, ends_at = $3 where id = $1", [ids[i], ...slot])
            .then(async () => ((await c.query("commit")), "ok"), async (err: { code?: string }) => ((await c.query("rollback")), err.code ?? "unknown"))));
        for (const r of results) codes.set(r, (codes.get(r) ?? 0) + 1);
      }
    } finally {
      await Promise.all(clients.map((c) => c.end().catch(() => {})));
    }
    assert.equal(codes.get("ok"), 20, summary(codes));
    assert.equal(codes.get("23P01"), 20 * (SESSIONS - 1), `every losing reschedule is an overlap refusal: ${summary(codes)}`);
  });

  test("control: without the per-calendar lock the same race produces deadlocks (40P01)", async () => {
    await admin.query("alter table public.appointments disable trigger appointments_lock_calendar");
    try {
      const codes = await race(ROUNDS, ROUNDS);
      console.log(`booking race outcomes without the lock: ${summary(codes)}`);
      assert.equal(codes.get("ok"), ROUNDS, "the exclusion constraint still stores one booking per slot");
      assert.ok((codes.get("40P01") ?? 0) > 0, `deadlocks reproduce without the lock: ${summary(codes)}`);
    } finally {
      await admin.query("alter table public.appointments enable trigger appointments_lock_calendar");
    }
  });
});
