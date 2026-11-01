// P3 display accuracy: pipeline columns match opportunities by stage id and calendar cards match
// bookings by calendar id in native mode; legacy mode keeps its name matching. Native data comes
// from the local fake Supabase (modelled RLS) through a client carrying the user's own JWT.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createClient } from "@supabase/supabase-js";
import { startFakeSupabase, type FakeSupabase, type FakeUser } from "./helpers/fake-supabase";
import { calendarAppointments, pipelineColumns } from "../src/lib/ui/board";
import { stageTotals } from "../src/lib/data/pipeline";
import { loadWorkspaceView } from "../src/lib/data/workspace";
import type { DataScope } from "../src/lib/data/query";
import type { RequestContext } from "../src/lib/authz/evaluate";
import type { AppointmentRecord, OpportunityRecord } from "../src/lib/data/records";

const WS = "00000000-0000-4000-8000-00000000a0a0";
const WS_B = "00000000-0000-4000-8000-00000000b0b0";
const owner: FakeUser = { id: "00000000-0000-4000-8000-0000000a0001", email: "owner@example.invalid", name: "Owner" };
const uid = (p: string, n: number) => `00000000-0000-4000-8000-${p}${String(n).padStart(12 - p.length, "0")}`;
const P = uid("a3", 1), P_OTHER = uid("a3", 2), P_B = uid("b3", 1);
const S = (n: number) => uid("a2", n);
const C = uid("a1", 1);

// Overlapping and duplicate names: "New Lead" / "New Lead Follow-up", and two stages named "Qualified".
const STAGES = [
  [1, "New Lead", "open"], [2, "Attempting Contact", "open"], [3, "New Lead Follow-up", "open"], [4, "Qualified", "open"],
  [5, "Appointment Booked", "open"], [6, "Appointment Completed", "open"], [7, "Estimate / Proposal Sent", "open"],
  [8, "Qualified", "open"], [9, "Decision Pending", "open"], [10, "Won", "won"], [11, "Lost", "lost"],
  [12, "Long-Term Nurture", "nurture"],
] as const;

const opp = (n: number, stage: string, value_cents: number, extra: Record<string, unknown> = {}) => ({
  id: uid("a6", n), workspace_id: WS, contact_id: C, pipeline_id: P, stage_id: stage, status: "open", value_cents,
  assigned_user_id: null, created_at: "2026-10-01T00:00:00Z", updated_at: `2026-10-0${(n % 9) + 1}T00:00:00Z`, deleted_at: null,
  ...extra,
});

let fake: FakeSupabase;
let scope: DataScope;

beforeEach(async () => {
  fake = await startFakeSupabase();
  fake.contexts.set(owner.id, {
    authenticated: true, user_id: owner.id, is_platform_admin: false, role: "owner", grant: null,
    workspace: { id: WS, name: "Alpha", slug: "alpha", status: "active" },
    permissions: ["dashboard.read", "contacts.read", "pipeline.read", "calendar.read", "settings.read"],
  });
  const token = fake.issue(owner).access_token;
  const ctx = {
    userId: owner.id, email: owner.email, name: owner.name, role: "owner", isPlatformAdmin: false, grant: null,
    workspace: { id: WS, name: "Alpha", slug: "alpha", status: "active" },
    permissions: ["dashboard.read", "contacts.read", "pipeline.read", "calendar.read", "settings.read"],
  } as unknown as RequestContext;
  scope = {
    ctx,
    supabase: createClient(fake.url, fake.anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    }),
  };
  fake.seed("workspace_settings", [{ workspace_id: WS, business_name: "Alpha" }]);
  fake.seed("pipelines", [
    { id: P, workspace_id: WS, name: "Sales Pipeline", is_default: true },
    { id: P_OTHER, workspace_id: WS, name: "Other Pipeline", is_default: false },
    { id: P_B, workspace_id: WS_B, name: "bravo", is_default: true },
  ]);
  fake.seed("pipeline_stages", [
    ...STAGES.map(([pos, name, kind]) => ({ id: S(pos), workspace_id: WS, pipeline_id: P, name, position: pos, kind })),
    { id: uid("a2", 99), workspace_id: WS, pipeline_id: P_OTHER, name: "Qualified", position: 1, kind: "open" },
    { id: uid("b2", 1), workspace_id: WS_B, pipeline_id: P_B, name: "Qualified", position: 1, kind: "open" },
  ]);
  fake.seed("calendars", []);
});

afterEach(async () => {
  await fake.close();
});

describe("native workspace view keeps stage ids", () => {
  test("stages come in board order with their ids, including duplicate names; a rename keeps the id", async () => {
    const view = await loadWorkspaceView(scope);
    assert.deepEqual(view.stages.map((s) => [s.id, s.name]), STAGES.map(([pos, name]) => [S(pos), name]));
    assert.equal(view.stages.filter((s) => s.name === "Qualified").length, 2, "duplicate names stay separate stages");

    fake.tables.get("pipeline_stages")!.find((r) => r.id === S(3))!.name = "Callback";
    const renamed = await loadWorkspaceView(scope);
    assert.deepEqual(renamed.stages[2], { id: S(3), name: "Callback", kind: "open" });
  });
});

describe("exact per-stage totals", () => {
  test("counts and cents per stage id: duplicates and overlapping names never double count", async () => {
    fake.seed("opportunities", [
      opp(1, S(1), 10_000), opp(2, S(3), 20_050), opp(3, S(4), 30_000), opp(4, S(8), 40_000), opp(5, S(8), 1),
      opp(6, S(10), 99_999),
      opp(7, S(8), 55_500, { deleted_at: "2026-10-09T00:00:00Z" }),
      opp(8, uid("a2", 99), 70_000, { pipeline_id: P_OTHER }),
    ]);
    const ids = (await loadWorkspaceView(scope)).stages.map((s) => s.id);
    const totals = await stageTotals(scope, ids);
    const at = (n: number) => totals.get(S(n));
    assert.deepEqual(at(1), { count: 1, valueCents: 10_000 });
    assert.deepEqual(at(3), { count: 1, valueCents: 20_050 });
    assert.deepEqual(at(4), { count: 1, valueCents: 30_000 }, "first Qualified");
    assert.deepEqual(at(8), { count: 2, valueCents: 40_001 }, "second Qualified; the deleted row is excluded");
    assert.deepEqual(at(10), { count: 1, valueCents: 99_999 });
    assert.deepEqual(at(2), { count: 0, valueCents: 0 });
    const sum = [...totals.values()].reduce((s, t) => ({ count: s.count + t.count, valueCents: s.valueCents + t.valueCents }),
      { count: 0, valueCents: 0 });
    assert.deepEqual(sum, { count: 6, valueCents: 200_050 }, "every live board opportunity counted once; other pipeline excluded");
  });

  test("totals page past the server's row cap", async () => {
    fake.limits.maxRows = 2;
    fake.seed("opportunities", [1, 2, 3, 4, 5, 6, 7].map((n) => opp(n, S(n % 2 ? 4 : 8), 100 * n)));
    const totals = await stageTotals(scope, [S(4), S(8)]);
    assert.deepEqual(totals.get(S(4)), { count: 4, valueCents: 100 * (1 + 3 + 5 + 7) });
    assert.deepEqual(totals.get(S(8)), { count: 3, valueCents: 100 * (2 + 4 + 6) });
  });
});

const record = (id: string, stageId: string, stageName: string, monetaryValue: number): OpportunityRecord =>
  ({ externalOpportunityId: id, stageId, stageName, status: "open", monetaryValue } as OpportunityRecord);

describe("pipeline columns", () => {
  const stages = STAGES.map(([pos, name, kind]) => ({ id: S(pos), name, kind }));
  const opportunities = [
    record("o-follow-up", S(3), "New Lead Follow-up", 200.5),
    record("o-qualified-2", S(8), "Qualified", 400),
    record("o-qualified-2b", S(8), "Qualified", 0.01),
    record("o-other-pipeline", uid("a2", 99), "Qualified", 700),
  ];
  const totals = new Map(stages.map((s) => [s.id, { count: 0, valueCents: 0 }]));
  totals.set(S(3), { count: 1, valueCents: 20_050 });
  totals.set(S(8), { count: 2, valueCents: 40_001 });

  test("native: each opportunity is in exactly one column, matched by stage id; values are exact", () => {
    const cols = pipelineColumns({ native: true, stages, stageNames: [], opportunities, totals });
    assert.deepEqual(cols.map((c) => c.key), stages.map((s) => s.id), "one column per stage, keyed by id");
    const byKey = new Map(cols.map((c) => [c.key, c]));
    assert.deepEqual(byKey.get(S(1))!.items, [], "New Lead does not absorb New Lead Follow-up");
    assert.deepEqual(byKey.get(S(4))!.items, [], "the first Qualified does not absorb the second");
    assert.deepEqual(byKey.get(S(3))!.items.map((o) => o.externalOpportunityId), ["o-follow-up"]);
    assert.deepEqual(byKey.get(S(8))!.items.map((o) => o.externalOpportunityId), ["o-qualified-2", "o-qualified-2b"]);
    assert.deepEqual([byKey.get(S(8))!.count, byKey.get(S(8))!.value], [2, 400.01]);
    const placed = cols.flatMap((c) => c.items.map((o) => o.externalOpportunityId));
    assert.equal(new Set(placed).size, placed.length, "no opportunity appears twice");
    assert.equal(placed.includes("o-other-pipeline"), false, "another pipeline's opportunity is not on this board");
    assert.equal(cols.reduce((s, c) => s + c.count, 0), 3);
  });

  test("legacy: the pre-P3 name matching is unchanged", () => {
    const cols = pipelineColumns({
      native: false, stages: [], stageNames: ["New Lead", "Qualified"], opportunities, totals: new Map(),
    });
    assert.deepEqual(cols.map((c) => [c.key, c.items.map((o) => o.externalOpportunityId)]), [
      ["New Lead", ["o-follow-up"]],
      ["Qualified", ["o-qualified-2", "o-qualified-2b", "o-other-pipeline"]],
    ]);
    assert.equal(cols[1].value, 1100.01);
  });
});

const booking = (id: string, calendarId: string, calendarName: string, status = "booked"): AppointmentRecord =>
  ({ externalAppointmentId: id, calendarId, calendarName, status, start: "2031-03-04T15:00:00Z" } as AppointmentRecord);

describe("calendar cards", () => {
  const discovery = { id: "cal-1", name: "Discovery Call", duration: "30 min" };
  const followUp = { id: "cal-2", name: "Discovery Follow-up", duration: "15 min" };
  const appointments = [booking("a1", "cal-1", "Discovery Call"), booking("a2", "cal-1", "Discovery Call", "cancelled")];

  test("native: bookings match by calendar id; an empty calendar with a similar name stays empty", () => {
    assert.deepEqual(calendarAppointments(true, discovery, appointments).map((a) => a.externalAppointmentId), ["a1", "a2"]);
    assert.deepEqual(calendarAppointments(true, followUp, appointments), [], "no fallback to another calendar's bookings");
    assert.deepEqual(calendarAppointments(true, { id: "cal-3", name: "Discovery Call", duration: "" }, appointments), [],
      "same name, different id");
  });

  test("legacy: the pre-P3 matching and fallback are unchanged", () => {
    assert.deepEqual(calendarAppointments(false, followUp, appointments).map((a) => a.externalAppointmentId), ["a1", "a2"]);
    assert.deepEqual(calendarAppointments(false, { id: "x", name: "Estimate Visit", duration: "" }, appointments)
      .map((a) => a.externalAppointmentId), ["a1", "a2"], "legacy falls back to every booking");
  });
});
