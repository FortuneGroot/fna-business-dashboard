/**
 * Round-3 integrity fixes at the app layer: database error mapping, bounded upload reads, search and
 * report-range input, time-zone display, calendar card order, and logo changes recorded through
 * rpc set_workspace_logo (member and platform routes).
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { NextRequest } from "next/server";
import { startFakeSupabase, type FakeSupabase, type FakeUser } from "./helpers/fake-supabase";
import { dbFailure } from "../src/lib/api/native";
import { readLimitedBody } from "../src/lib/http/limited-body";
import { searchWords } from "../src/lib/native/records";
import { reportQuery, reportRange } from "../src/lib/native/reports";
import { fromLocalInput, isSkippedLocalTime, toLocalInput, when } from "../src/lib/ui/native-api";
import { soonestFirst } from "../src/lib/ui/board";
import { DELETE as deleteMemberLogo, GET as getMemberLogo, PUT as putMemberLogo } from "../src/app/api/settings/logo/route";
import { DELETE as deletePlatformLogo, PUT as putPlatformLogo } from "../src/app/api/platform/workspace-logo/route";

const DAY = 86_400_000;

describe("database failures keep their meaning", () => {
  test("ended sessions are 401, serialization and deadlock are a retryable 409, logo and email refusals are explicit", () => {
    const status = (e: { code?: string; message?: string }) => {
      const err = dbFailure(e);
      return [err.status, err.code];
    };
    for (const code of ["PGRST301", "PGRST302", "PGRST303", "PT401"]) assert.deepEqual(status({ code }), [401, "unauthenticated"], code);
    assert.deepEqual(status({ code: "P0001", message: "session_ended" }), [401, "unauthenticated"]);
    assert.deepEqual(status({ code: "40001" }), [409, "retry"]);
    assert.deepEqual(status({ code: "40P01" }), [409, "retry"]);
    assert.deepEqual(status({ code: "P0002", message: "logo_missing" }), [409, "conflict"], "not a 404");
    assert.deepEqual(status({ code: "P0001", message: "invitation_email_unverified" }), [403, "invitation_email_unverified"]);
    assert.deepEqual(status({ code: "P0001", message: "invitation_revoked" })[0], 410);
  });
});

describe("upload bodies are read only up to the limit", () => {
  const streamed = (chunks: number[], onCancel: () => void, pulled: { n: number }) =>
    new Request("http://localhost/x", {
      method: "PUT",
      // @ts-expect-error duplex is required by Node for a streamed body
      duplex: "half",
      body: new ReadableStream<Uint8Array>({
        pull(c) {
          const size = chunks[pulled.n++];
          if (size === undefined) c.close();
          else c.enqueue(new Uint8Array(size));
        },
        cancel: onCancel,
      }),
    });

  test("a declared oversize body is refused without reading it", async () => {
    const req = new Request("http://localhost/x", {
      method: "PUT",
      headers: { "content-length": "11" },
      // @ts-expect-error duplex is required by Node for a streamed body
      duplex: "half",
      body: new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(11)); c.close(); } }),
    });
    assert.equal(await readLimitedBody(req, 10), null);
    assert.equal(req.bodyUsed, false, "the body was never read");
  });

  test("an undeclared stream stops at the first byte over the limit and is cancelled", async () => {
    let cancelled = false;
    const pulled = { n: 0 };
    assert.equal(await readLimitedBody(streamed([6, 6, 6, 6], () => { cancelled = true; }, pulled), 10), null);
    assert.equal(cancelled, true, "the rest of the upload is not consumed");
    assert.ok(pulled.n <= 3, `stopped early (${pulled.n} pulls)`);
  });

  test("a body of exactly the limit is returned whole; an empty body is empty", async () => {
    const bytes = await readLimitedBody(streamed([4, 6], () => undefined, { n: 0 }), 10);
    assert.equal(bytes?.byteLength, 10);
    assert.equal((await readLimitedBody(new Request("http://localhost/x", { method: "PUT" }), 10))?.byteLength, 0);
  });
});

describe("search words cannot carry filter syntax", () => {
  test("ilike wildcards and PostgREST punctuation separate words and never survive", () => {
    assert.deepEqual(searchWords("jo_n"), ["jo", "n"]);
    assert.deepEqual(searchWords("50%"), ["50"]);
    assert.deepEqual(searchWords("a,b.or(id.eq.1)"), ["a", "b.or", "id.eq.1"]);
    assert.deepEqual(searchWords("x*y\\z\"q`"), ["x", "y", "z", "q"]);
    assert.deepEqual(searchWords("_%_"), [], "only wildcards: no search at all");
    for (const w of searchWords("%_,()*\\\":;!{}[]<>|&=~ name@example.com O'Neil a+b")) {
      assert.match(w, /^[\p{L}\p{N}@.+'-]+$/u, w);
    }
  });
});

describe("report ranges", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  const ok = (q: object) => reportQuery.safeParse(q).success;

  test("defaults: both omitted is the last 30 days; to-only is the 30 days before it; from-only ends now", () => {
    assert.deepEqual(reportRange({}, now), { from: "2026-10-03T12:00:00.000Z", to: "2026-11-02T12:00:00.000Z" });
    assert.deepEqual(reportRange({ to: "2026-06-01T00:00:00Z" }, now), { from: "2026-05-02T00:00:00.000Z", to: "2026-06-01T00:00:00.000Z" });
    assert.deepEqual(reportRange({ from: "2026-10-01T00:00:00Z" }, now), { from: "2026-10-01T00:00:00.000Z", to: "2026-11-02T12:00:00.000Z" });
    assert.ok(ok({}) && ok({ to: "2026-06-01T00:00:00Z" }));
  });

  test("reversed, empty, future-only and over-400-day ranges are refused; exactly 400 days is allowed", () => {
    assert.equal(ok({ from: "2026-06-02T00:00:00Z", to: "2026-06-01T00:00:00Z" }), false, "reversed");
    assert.equal(ok({ from: "2026-06-01T00:00:00Z", to: "2026-06-01T00:00:00Z" }), false, "empty");
    assert.equal(ok({ from: new Date(Date.now() + DAY).toISOString() }), false, "from in the future with no to");
    const from = Date.parse("2025-01-01T00:00:00Z");
    assert.equal(ok({ from: new Date(from).toISOString(), to: new Date(from + 400 * DAY).toISOString() }), true, "400 days");
    assert.equal(ok({ from: new Date(from).toISOString(), to: new Date(from + 400 * DAY + 1000).toISOString() }), false, "400 days + 1 s");
    assert.equal(ok({ from: new Date(Date.now() - 401 * DAY).toISOString() }), false, "from-only older than 400 days");
    assert.equal(ok({ from: "2026-06-01T00:00:00" }), false, "a time without a zone");
  });
});

describe("task and booking times across time zones", () => {
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  test("the form's local time is stored as the right instant and listed in UTC across day boundaries", () => {
    process.env.TZ = "America/New_York";
    const iso = fromLocalInput("2026-11-01T23:30");
    assert.equal(iso, "2026-11-02T04:30:00.000Z", "11:30 pm EST is the next UTC day");
    assert.equal(when(iso), "2026-11-02 04:30");
    assert.equal(toLocalInput(iso), "2026-11-01T23:30", "editing shows the time that was entered");
    assert.equal(isSkippedLocalTime("2026-03-08T02:30"), true, "spring-forward gap");
    assert.equal(isSkippedLocalTime("2026-03-08T03:30"), false);

    process.env.TZ = "Asia/Kolkata";
    assert.equal(fromLocalInput("2026-11-02T00:15"), "2026-11-01T18:45:00.000Z", "a half-hour zone, previous UTC day");
    process.env.TZ = "Pacific/Auckland";
    const nz = fromLocalInput("2026-01-01T09:00");
    assert.equal(nz, "2025-12-31T20:00:00.000Z", "NZ summer time, previous UTC year");
    assert.equal(toLocalInput(nz), "2026-01-01T09:00");
    assert.equal(when(nz), "2025-12-31 20:00", "the list is the same in every zone");
  });
});

describe("calendar cards", () => {
  test("upcoming bookings come first, soonest first; then past bookings, most recent first", () => {
    const now = Date.parse("2026-11-02T12:00:00Z");
    const at = (id: string, start: string, end: string) => ({ id, start, end });
    const items = [
      at("past-old", "2026-10-01T09:00:00Z", "2026-10-01T10:00:00Z"),
      at("far", "2026-12-24T09:00:00Z", "2026-12-24T10:00:00Z"),
      at("in-progress", "2026-11-02T11:30:00Z", "2026-11-02T12:30:00Z"),
      at("past-recent", "2026-11-01T09:00:00Z", "2026-11-01T10:00:00Z"),
      at("next", "2026-11-03T09:00:00Z", "2026-11-03T10:00:00Z"),
    ];
    assert.deepEqual(soonestFirst(items, now).map((a) => a.id), ["in-progress", "next", "far", "past-recent", "past-old"]);
    assert.deepEqual(items[0].id, "past-old", "the input is not reordered in place");
  });
});

const WS = "00000000-0000-4000-8000-0000000000aa";
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(8)]);
const JPG = Buffer.concat([Buffer.from("ffd8ffe0", "hex"), Buffer.alloc(8)]);
const owner: FakeUser = { id: "00000000-0000-4000-8000-0000000000b1", email: "owner@example.invalid", name: "Owner" };
const employee: FakeUser = { id: "00000000-0000-4000-8000-0000000000b2", email: "employee@example.invalid", name: "Employee" };
const admin: FakeUser = { id: "00000000-0000-4000-8000-0000000000a1", email: "admin@example.invalid", name: "Platform Admin" };
const workspace = { id: WS, name: "A", slug: "a", status: "active" };
const ENV_KEYS = ["AUTH_PROVIDER", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"];

function req(path: string, init: { cookie: string; method?: string; body?: Buffer; contentType?: string }) {
  const headers = new Headers({ cookie: init.cookie });
  if (init.body !== undefined) headers.set("content-type", init.contentType ?? "image/png");
  return new NextRequest(new URL(path, "http://localhost:3000"), { method: init.method ?? "GET", headers, body: init.body });
}

describe("logo changes are recorded through set_workspace_logo", () => {
  let fake: FakeSupabase;
  let restoreEnv: () => void;
  let ownerCookie: string;
  let adminCookie: string;

  beforeEach(async () => {
    const prev = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    restoreEnv = () => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    };
    fake = await startFakeSupabase();
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.AUTH_PROVIDER = "supabase";
    process.env.SUPABASE_URL = fake.url;
    process.env.SUPABASE_ANON_KEY = fake.anonKey;
    process.env.SUPABASE_SERVICE_ROLE_KEY = fake.serviceKey;
    const member = (u: FakeUser, role: string, permissions: string[]) => ({
      authenticated: true, user_id: u.id, is_platform_admin: false, workspace, role, grant: null, permissions,
    });
    fake.contexts.set(owner.id, member(owner, "owner", ["dashboard.read", "settings.read", "settings.write"]));
    fake.contexts.set(employee.id, member(employee, "employee", ["dashboard.read", "settings.read"]));
    fake.contexts.set(admin.id, {
      authenticated: true, user_id: admin.id, is_platform_admin: true, workspace, role: null,
      grant: { id: "00000000-0000-4000-8000-0000000000f1", mode: "write", expires_at: "2099-01-01T00:00:00Z" },
      permissions: ["dashboard.read", "settings.read"],
    });
    ownerCookie = fake.cookie(fake.issue(owner));
    adminCookie = fake.cookie(fake.issue(admin));
  });

  afterEach(async () => {
    restoreEnv();
    await fake.close();
  });

  const logoObjects = () => [...fake.objects.keys()].filter((k) => k.startsWith(`${WS}/logo`)).sort();

  test("each member upload gets its own object; replacing removes the previous one, deleting clears both", async () => {
    const first = await putMemberLogo(req("/api/settings/logo", { cookie: ownerCookie, method: "PUT", body: PNG }));
    assert.equal(first.status, 200);
    assert.ok((await first.json()).logo?.url, "a signed URL for the new logo");
    const firstPath = fake.logo.path;
    assert.match(firstPath ?? "", new RegExp(`^${WS}/logo-[0-9a-f-]{36}\\.png$`));
    assert.deepEqual(logoObjects(), [firstPath]);

    const second = await putMemberLogo(req("/api/settings/logo", { cookie: ownerCookie, method: "PUT", body: JPG, contentType: "image/jpeg" }));
    assert.equal(second.status, 200);
    assert.match(fake.logo.path ?? "", /\.jpg$/, "a different format is a different object");
    assert.deepEqual(logoObjects(), [fake.logo.path], "the replaced logo was removed");

    const got = await getMemberLogo(req("/api/settings/logo", { cookie: ownerCookie }));
    assert.ok((await got.json()).logo?.url);

    const del = await deleteMemberLogo(req("/api/settings/logo", { cookie: ownerCookie, method: "DELETE" }));
    assert.equal(del.status, 200);
    assert.equal(fake.logo.path, null);
    assert.deepEqual(logoObjects(), []);
    assert.equal((await (await getMemberLogo(req("/api/settings/logo", { cookie: ownerCookie }))).json()).logo, null);
  });

  test("overlapping member uploads: the last swap wins, and the record always names an existing object", async () => {
    const results = await Promise.all([PNG, JPG, PNG].map((body, i) =>
      putMemberLogo(req("/api/settings/logo", { cookie: ownerCookie, method: "PUT", body, contentType: i === 1 ? "image/jpeg" : "image/png" }))));
    assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
    assert.ok(fake.logo.path && fake.objects.has(fake.logo.path), "logo_path names a stored object");
    assert.deepEqual(logoObjects(), [fake.logo.path], "every superseded upload was removed");
  });

  test("an upload whose record update fails removes its own object and leaves the current logo", async () => {
    await putMemberLogo(req("/api/settings/logo", { cookie: ownerCookie, method: "PUT", body: PNG }));
    const current = fake.logo.path;
    const original = fake.rpc.set_workspace_logo;
    fake.rpc.set_workspace_logo = () => ({ status: 500, body: { code: "XX000", message: "injected failure" } });
    const res = await putMemberLogo(req("/api/settings/logo", { cookie: ownerCookie, method: "PUT", body: JPG, contentType: "image/jpeg" }));
    fake.rpc.set_workspace_logo = original;
    assert.equal(res.status, 503);
    assert.equal(fake.logo.path, current);
    assert.deepEqual(logoObjects(), [current], "no orphaned upload, the current logo intact");
  });

  test("old leftovers are cleaned up; a recent unrecorded upload (another request mid-flight) is kept", async () => {
    const stale = `${WS}/logo-11111111-1111-4111-8111-111111111111.png`;
    const fresh = `${WS}/logo-22222222-2222-4222-8222-222222222222.png`;
    for (const p of [stale, fresh]) fake.objects.set(p, { version: 0, token: null, writtenBy: "user" });
    fake.objectTimes.set(stale, new Date(Date.now() - 11 * 60_000).toISOString());
    fake.objectTimes.set(fresh, new Date().toISOString());
    await putMemberLogo(req("/api/settings/logo", { cookie: ownerCookie, method: "PUT", body: PNG }));
    assert.equal(fake.objects.has(stale), false);
    assert.equal(fake.objects.has(fresh), true);
  });

  test("members without settings.write cannot change the logo; a mislabelled or oversized file is refused", async () => {
    const employeeCookie = fake.cookie(fake.issue(employee));
    assert.equal((await putMemberLogo(req("/api/settings/logo", { cookie: employeeCookie, method: "PUT", body: PNG }))).status, 403);
    const wrong = await putMemberLogo(req("/api/settings/logo", { cookie: ownerCookie, method: "PUT", body: JPG, contentType: "image/png" }));
    assert.equal(wrong.status, 422);
    const big = await putMemberLogo(req("/api/settings/logo", { cookie: ownerCookie, method: "PUT", body: Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]) }));
    assert.equal(big.status, 422);
    assert.deepEqual(logoObjects(), []);
    assert.equal(fake.logo.path, null);
  });

  test("platform upload is recorded as the logo; platform delete without ext removes whatever the logo is", async () => {
    const put = await putPlatformLogo(req("/api/platform/workspace-logo", { cookie: adminCookie, method: "PUT", body: PNG }));
    assert.equal(put.status, 200);
    assert.equal(fake.logo.path, `${WS}/logo.png`, "workspace_settings.logo_path follows the platform write");

    const mismatch = await putPlatformLogo(req("/api/platform/workspace-logo", { cookie: adminCookie, method: "PUT", body: JPG, contentType: "image/png" }));
    assert.equal(mismatch.status, 422, "content must match the declared type");

    await putMemberLogo(req("/api/settings/logo", { cookie: ownerCookie, method: "PUT", body: JPG, contentType: "image/jpeg" }));
    const memberPath = fake.logo.path!;
    assert.match(memberPath, /logo-[0-9a-f-]{36}\.jpg$/);

    const del = await deletePlatformLogo(req("/api/platform/workspace-logo", { cookie: adminCookie, method: "DELETE" }));
    assert.equal(del.status, 200, JSON.stringify(await del.clone().json()));
    assert.equal(fake.logo.path, null);
    assert.equal(fake.objects.has(memberPath), false, "the member's uniquely named logo was removed");

    const none = await deletePlatformLogo(req("/api/platform/workspace-logo", { cookie: adminCookie, method: "DELETE" }));
    assert.equal(none.status, 404);
  });

  test("a platform delete of a fixed name that is no longer the logo leaves the current logo recorded", async () => {
    await putPlatformLogo(req("/api/platform/workspace-logo", { cookie: adminCookie, method: "PUT", body: PNG }));
    await putMemberLogo(req("/api/settings/logo", { cookie: ownerCookie, method: "PUT", body: JPG, contentType: "image/jpeg" }));
    const memberPath = fake.logo.path;
    await deletePlatformLogo(req("/api/platform/workspace-logo?ext=png", { cookie: adminCookie, method: "DELETE" }));
    assert.equal(fake.logo.path, memberPath, "only a delete of the recorded logo clears the record");
    assert.ok(fake.objects.has(memberPath!));
  });
});
