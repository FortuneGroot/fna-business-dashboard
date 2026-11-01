// P4 team and settings (spec §7.4): input validation, §7.1 error mapping, cursors, and route
// behaviour against the local fake Supabase (tests/helpers/fake-supabase.ts; nothing leaves
// 127.0.0.1). Database authorization itself (roles, last owner, invitations) is exercised against
// the real local Supabase stack in tests/supabase-stack/stack.test.ts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { NextRequest } from "next/server";
import { startFakeSupabase, type FakeSupabase, type FakeUser } from "./helpers/fake-supabase";
import { ApiError, appOrigin, dbFailure, decodeCursor, encodeCursor, parseId } from "../src/lib/api/native";
import { aiPatch, isTimeZone, settingsPatch } from "../src/lib/native/settings";
import { invitationInput, invitationStatus } from "../src/lib/native/invitations";
import { memberPatch } from "../src/lib/native/team";
import { publicConfig } from "../src/lib/native/integrations";
import { z } from "zod";
import { GET as getTeam } from "../src/app/api/team/route";
import { DELETE as deleteMember, PATCH as patchMember } from "../src/app/api/team/[userId]/route";
import { GET as getInvitations, POST as postInvitation } from "../src/app/api/team/invitations/route";
import { DELETE as deleteInvitation } from "../src/app/api/team/invitations/[id]/route";
import { GET as peekRoute } from "../src/app/api/invitations/[token]/route";
import { POST as acceptRoute } from "../src/app/api/invitations/[token]/accept/route";
import { GET as getSettings, PATCH as patchSettings } from "../src/app/api/settings/workspace/route";
import { GET as getAi, PUT as putAi } from "../src/app/api/settings/ai-receptionist/route";
import { GET as getIntegrations } from "../src/app/api/integrations/route";
import { GET as getAudit } from "../src/app/api/audit/route";
import { GET as getChecklist } from "../src/app/api/onboarding/checklist/route";

const ROOT = join(__dirname, "..");
const ENV_KEYS = [
  "AUTH_PROVIDER", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY",
  "AUTH_SECRET", "AUTH_OWNER_EMAIL", "AUTH_OWNER_PASSWORD", "AUTH_ALLOW_MEMORY_SESSIONS", "VERCEL_ENV", "AUTH_FAIL_CLOSED",
];
const WS_A = "00000000-0000-4000-8000-00000000a0a0";
const WS_B = "00000000-0000-4000-8000-00000000b0b0";
const OWNER_PERMS = [
  "dashboard.read", "settings.read", "settings.write", "ai_receptionist.read", "ai_receptionist.write",
  "integrations.read", "integrations.manage", "team.read", "team.invite_employee", "team.invite_admin",
  "team.invite_owner", "team.change_role", "team.remove", "team.manage_overrides", "audit.read", "onboarding.read",
];
const EMPLOYEE_PERMS = ["dashboard.read", "settings.read", "team.read"];
const ownerA: FakeUser = { id: "00000000-0000-4000-8000-0000000a0001", email: "owner-a@example.invalid", name: "Owner A" };
const employeeA: FakeUser = { id: "00000000-0000-4000-8000-0000000a0003", email: "employee-a@example.invalid", name: "Employee A" };
const TOKEN = "ab".repeat(32);
const ws = (id: string, name: string) => ({ id, name, slug: name.toLowerCase(), status: "active" });
const memberCtx = (u: FakeUser, role: string, permissions: string[]) => ({
  authenticated: true, user_id: u.id, is_platform_admin: false, workspace: ws(WS_A, "Alpha"), role, grant: null, permissions,
});

// Route handlers type their own params; tests pass them as a plain record.
type Handler = (req: NextRequest, ctx: { params: Promise<any> }) => Promise<Response>;
const params = (p: Record<string, string> = {}) => ({ params: Promise.resolve(p) });

function req(path: string, init: { cookie?: string; method?: string; body?: unknown } = {}) {
  const headers = new Headers();
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return new NextRequest(new URL(path, "http://localhost:3000"), {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  });
}

async function json(res: Response) {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
describe("P4 validation (zod, strict)", () => {
  test("settings: valid partial patches pass; unknown keys, logo, bad timezone/URL/email/phone, and empty patches fail", () => {
    assert.ok(settingsPatch.safeParse({ businessName: " Alpha ", timezone: "America/Chicago" }).success);
    assert.ok(settingsPatch.safeParse({ supportEmail: null, websiteUrl: "https://alpha.example.invalid" }).success);
    assert.ok(settingsPatch.safeParse({ businessHours: { mon: [{ start: "09:00", end: "17:00" }] } }).success);
    for (const bad of [
      {}, { logoPath: "x/logo.png" }, { businessName: "" }, { businessName: "x".repeat(121) }, { timezone: "Mars/Olympus" },
      { websiteUrl: "javascript:alert(1)" }, { websiteUrl: "alpha.example" }, { supportEmail: "nope" },
      { businessPhone: "call me" }, { brandColors: { primary: "red" } }, { brandColors: { other: "#000000" } },
      { businessHours: { mon: [{ start: "17:00", end: "09:00" }] } }, { businessHours: { funday: [] } }, { updated_by: "x" },
    ]) {
      assert.equal(settingsPatch.safeParse(bad).success, false, JSON.stringify(bad));
    }
    assert.equal(isTimeZone("UTC"), true);
    assert.equal(isTimeZone("Not/AZone"), false);
  });

  test("AI receptionist: enabled can only restate false; no secrets or unknown keys; FAQ bounded", () => {
    assert.ok(aiPatch.safeParse({ greeting: "Hi", enabled: false }).success);
    assert.equal(aiPatch.safeParse({ enabled: true }).success, false);
    assert.equal(aiPatch.safeParse({ apiKey: "k" }).success, false);
    assert.equal(aiPatch.safeParse({ provider_secret: "k" }).success, false);
    assert.equal(aiPatch.safeParse({ businessHoursMode: "sometimes" }).success, false);
    assert.equal(aiPatch.safeParse({ escalationUserId: "not-a-uuid" }).success, false);
    const faq = Array.from({ length: 51 }, () => ({ question: "q", answer: "a" }));
    assert.equal(aiPatch.safeParse({ faq }).success, false);
    assert.ok(aiPatch.safeParse({ faq: faq.slice(0, 50) }).success);
  });

  test("invitations: email normalized; only owner/admin/employee roles (INV-5); TTL at most 7 days (INV-2)", () => {
    const ok = invitationInput.parse({ email: "  New.Person@Example.INVALID ", role: "employee" });
    assert.equal(ok.email, "new.person@example.invalid");
    for (const role of ["platform_admin", "superuser", "", "OWNER"]) {
      assert.equal(invitationInput.safeParse({ email: "a@example.invalid", role }).success, false, role);
    }
    assert.equal(invitationInput.safeParse({ email: "a@example.invalid", role: "admin", ttlHours: 169 }).success, false);
    assert.equal(invitationInput.safeParse({ email: "a@example.invalid", role: "admin", ttlHours: 0 }).success, false);
    assert.equal(invitationInput.safeParse({ email: "not-an-email", role: "admin" }).success, false);
    assert.equal(invitationInput.safeParse({ email: "a@example.invalid", role: "admin", workspace: "x" }).success, false);
  });

  test("member patch: exactly one of role or overrides; permission keys checked; null clears", () => {
    assert.ok(memberPatch.safeParse({ role: "admin" }).success);
    assert.ok(memberPatch.safeParse({ overrides: { "contacts.delete": true, "tasks.write": null } }).success);
    for (const bad of [{}, { role: "platform_admin" }, { role: "admin", overrides: { "contacts.read": true } },
      { overrides: {} }, { overrides: { "DROP TABLE": true } }, { overrides: { "contacts.read": "yes" } }]) {
      assert.equal(memberPatch.safeParse(bad).success, false, JSON.stringify(bad));
    }
  });

  test("route ids must be UUIDs (422)", () => {
    assert.equal(parseId("00000000-0000-4000-8000-0000000a0001"), "00000000-0000-4000-8000-0000000a0001");
    assert.throws(() => parseId("1; drop table"), (e: unknown) => e instanceof ApiError && e.status === 422);
  });
});

describe("P4 §7.1 error mapping and cursors", () => {
  test("database codes map to the documented statuses; unknown failures are 503, never 4xx", () => {
    const cases: [Record<string, string>, number, string][] = [
      [{ message: "forbidden", code: "42501" }, 403, "forbidden"],
      [{ message: "new row violates row-level security policy", code: "42501" }, 403, "forbidden"],
      [{ message: "not_found", code: "P0002" }, 404, "not_found"],
      [{ message: "conflict", code: "23505" }, 409, "conflict"],
      [{ message: "already_member", code: "23505" }, 409, "already_member"],
      [{ message: "validation_failed", code: "22023" }, 422, "validation_failed"],
      [{ message: "a workspace must keep at least one active owner", code: "23514" }, 409, "last_owner"],
      [{ message: "permission overrides apply to active employees only", code: "23514" }, 422, "validation_failed"],
      [{ message: "escalation_user_id must reference an active member of the same workspace", code: "23503" }, 422, "validation_failed"],
      [{ message: "conflicting key value violates exclusion constraint", code: "23P01" }, 409, "overlap"],
      [{ message: "invitation_expired", code: "P0001" }, 410, "invitation_expired"],
      [{ message: "invitation_used", code: "P0001" }, 410, "invitation_used"],
      [{ message: "invitation_revoked", code: "P0001" }, 410, "invitation_revoked"],
      [{ message: "invitation_not_found", code: "P0001" }, 404, "invitation_not_found"],
      [{ message: "invitation_email_mismatch", code: "P0001" }, 403, "invitation_email_mismatch"],
      [{ message: "workspace_suspended", code: "P0001" }, 423, "workspace_suspended"],
      [{ message: "TypeError: fetch failed", code: "" }, 503, "unavailable"],
      [{ message: "function not found", code: "PGRST202" }, 503, "unavailable"],
    ];
    for (const [error, status, code] of cases) {
      const mapped = dbFailure(error);
      assert.deepEqual([mapped.status, mapped.code], [status, code], JSON.stringify(error));
    }
  });

  test("cursors round-trip; malformed or tampered cursors are 422", () => {
    const schema = z.strictObject({ id: z.number().int().positive() });
    assert.deepEqual(decodeCursor(encodeCursor({ id: 42 }), schema), { id: 42 });
    assert.equal(decodeCursor(undefined, schema), null);
    for (const bad of ["%%%", "bm90IGpzb24", encodeCursor({ id: -1 }), encodeCursor({ id: 1, extra: 2 })]) {
      assert.throws(() => decodeCursor(bad, schema), (e: unknown) => e instanceof ApiError && e.status === 422, bad);
    }
  });

  test("integration config never exposes secret-looking keys; invitation status is derived", () => {
    assert.deepEqual(publicConfig({ region: "us", api_key: "k", apiKey: "k", webhook_secret: "s", accessToken: "t", password: "p" }), { region: "us" });
    assert.deepEqual(publicConfig(null), {});
    const future = new Date(Date.now() + 3600_000).toISOString();
    const past = new Date(Date.now() - 1000).toISOString();
    assert.equal(invitationStatus({ accepted_at: null, revoked_at: null, expires_at: future }), "pending");
    assert.equal(invitationStatus({ accepted_at: null, revoked_at: null, expires_at: past }), "expired");
    assert.equal(invitationStatus({ accepted_at: past, revoked_at: null, expires_at: future }), "accepted");
    assert.equal(invitationStatus({ accepted_at: null, revoked_at: past, expires_at: future }), "revoked");
  });
});

// ---------------------------------------------------------------------------
describe("P4 invite link origin", () => {
  const at = (headers: Record<string, string>) =>
    new NextRequest(new URL("/api/team/invitations", "http://localhost:3000"), { headers: new Headers(headers) });
  afterEach(() => {
    delete process.env.APP_ORIGIN;
  });

  test("uses the request's host (and forwarded proto), APP_ORIGIN when pinned, and never an invalid host", () => {
    assert.equal(appOrigin(at({ host: "127.0.0.1:4442" })), "http://127.0.0.1:4442");
    assert.equal(appOrigin(at({ host: "internal:3000", "x-forwarded-host": "app.example.test", "x-forwarded-proto": "https" })),
      "https://app.example.test");
    assert.equal(appOrigin(at({ host: "evil.test/path?x=" })), "http://localhost:3000", "malformed host falls back");
    assert.equal(appOrigin(at({ host: "a.test", "x-forwarded-proto": "javascript" })), "http://localhost:3000");
    process.env.APP_ORIGIN = "https://dashboard.example.test/ignored";
    assert.equal(appOrigin(at({ host: "other.test" })), "https://dashboard.example.test");
    process.env.APP_ORIGIN = "not a url";
    assert.throws(() => appOrigin(at({ host: "other.test" })), (e: ApiError) => e.status === 503);
  });
});

describe("P4 routes (AUTH_PROVIDER=supabase, fake Supabase)", () => {
  let fake: FakeSupabase;
  let restoreEnv: () => void;
  const cookie = (u: FakeUser) => fake.cookie(fake.issue(u));

  beforeEach(async () => {
    const prev: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) prev[k] = process.env[k];
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
    fake.contexts.set(ownerA.id, memberCtx(ownerA, "owner", OWNER_PERMS));
    fake.contexts.set(employeeA.id, memberCtx(employeeA, "employee", EMPLOYEE_PERMS));
    fake.seed("workspace_settings", [
      { workspace_id: WS_A, business_name: "Alpha Plumbing", legal_name: "", timezone: "America/Chicago", industry: "",
        support_email: null, business_phone: null, website_url: null, booking_url: null, review_url: null,
        brand_colors: {}, business_hours: {}, logo_path: null, updated_at: "2026-10-01T00:00:00Z" },
      { workspace_id: WS_B, business_name: "bravo Moving", legal_name: "", timezone: "America/New_York", industry: "",
        support_email: "bravo@example.invalid", business_phone: null, website_url: null, booking_url: null, review_url: null,
        brand_colors: {}, business_hours: {}, logo_path: null, updated_at: "2026-10-01T00:00:00Z" },
    ]);
    fake.seed("integrations", [
      { workspace_id: WS_A, provider: "calendar_sync", status: "disconnected", capabilities: [], verified_at: null,
        config: { region: "us", api_key: "must-not-leak", clientSecret: "must-not-leak" }, updated_at: "2026-10-01T00:00:00Z" },
      { workspace_id: WS_B, provider: "bravo_crm", status: "connected", capabilities: ["x"], verified_at: "2026-10-01T00:00:00Z",
        config: {}, updated_at: "2026-10-01T00:00:00Z" },
    ]);
    fake.seed("workspace_audit_log", [1, 2, 3].map((n) => ({
      id: n, workspace_id: WS_A, actor_id: ownerA.id, actor_kind: "member", action: `settings.updated`, target: "workspace_settings",
      metadata: { fields: ["business_name"] }, created_at: `2026-10-0${n}T00:00:00Z`,
    })).concat([{ id: 4, workspace_id: WS_B, actor_id: null, actor_kind: "system", action: "bravo.secret", target: null,
      metadata: {}, created_at: "2026-10-04T00:00:00Z" } as never]));
    fake.seed("profiles", [{ user_id: ownerA.id, full_name: "Owner A" }]);
  });

  afterEach(async () => {
    await fake.close();
    restoreEnv();
  });

  const READ_ROUTES: [string, Handler, Record<string, string>?][] = [
    ["/api/team", getTeam as Handler], ["/api/team/invitations", getInvitations as Handler],
    ["/api/settings/workspace", getSettings as Handler], ["/api/settings/ai-receptionist", getAi as Handler],
    ["/api/integrations", getIntegrations as Handler], ["/api/audit", getAudit as Handler],
    ["/api/onboarding/checklist", getChecklist as Handler],
  ];

  test("every P4 route refuses a request without a session (401 unauthenticated)", async () => {
    for (const [path, handler] of READ_ROUTES) {
      const r = await json(await handler(req(path), params()));
      assert.deepEqual([r.status, r.body.code], [401, "unauthenticated"], path);
    }
    const r = await json(await (postInvitation as Handler)(req("/api/team/invitations", { method: "POST", body: { email: "x@example.invalid", role: "employee" } }), params()));
    assert.equal(r.status, 401);
  });

  test("an employee is refused owner/admin operations before any RPC runs (403, nothing called)", async () => {
    const c = cookie(employeeA);
    for (const [path, handler] of [["/api/integrations", getIntegrations], ["/api/audit", getAudit],
      ["/api/onboarding/checklist", getChecklist], ["/api/settings/ai-receptionist", getAi]] as [string, Handler][]) {
      const r = await json(await handler(req(path, { cookie: c }), params()));
      assert.deepEqual([r.status, r.body.code], [403, "forbidden"], path);
    }
    const target = "00000000-0000-4000-8000-0000000a0009";
    const denied = [
      await (patchSettings as Handler)(req("/api/settings/workspace", { cookie: c, method: "PATCH", body: { businessName: "X" } }), params()),
      await (putAi as Handler)(req("/api/settings/ai-receptionist", { cookie: c, method: "PUT", body: { greeting: "X" } }), params()),
      await (postInvitation as Handler)(req("/api/team/invitations", { cookie: c, method: "POST", body: { email: "x@example.invalid", role: "employee" } }), params()),
      await (patchMember as Handler)(req(`/api/team/${target}`, { cookie: c, method: "PATCH", body: { role: "admin" } }), params({ userId: target })),
      await (patchMember as Handler)(req(`/api/team/${target}`, { cookie: c, method: "PATCH", body: { overrides: { "contacts.delete": true } } }), params({ userId: target })),
      await (deleteMember as Handler)(req(`/api/team/${target}`, { cookie: c, method: "DELETE" }), params({ userId: target })),
      await (deleteInvitation as Handler)(req(`/api/team/invitations/${target}`, { cookie: c, method: "DELETE" }), params({ id: target })),
    ];
    for (const res of denied) assert.deepEqual([res.status, ((await res.json()) as { code: string }).code], [403, "forbidden"]);
    for (const name of ["create_invitation", "set_member_role", "set_member_permissions", "remove_member", "revoke_invitation"]) {
      assert.equal(fake.rpcCalls(name).length, 0, `${name} must not be called`);
    }
  });

  test("an admin cannot invite an owner or admin (team.invite_* by role)", async () => {
    fake.contexts.set(employeeA.id, memberCtx(employeeA, "admin", ["team.read", "team.invite_employee", "team.remove", "team.manage_overrides"]));
    for (const role of ["admin", "owner"]) {
      const r = await json(await (postInvitation as Handler)(req("/api/team/invitations", { cookie: cookie(employeeA), method: "POST", body: { email: "x@example.invalid", role } }), params()));
      assert.deepEqual([r.status, r.body.code], [403, "forbidden"], role);
    }
    const r = await json(await (patchMember as Handler)(req(`/api/team/${ownerA.id}`, { cookie: cookie(employeeA), method: "PATCH", body: { role: "employee" } }), params({ userId: ownerA.id })));
    assert.deepEqual([r.status, r.body.code], [403, "forbidden"], "admin cannot change roles");
    assert.equal(fake.rpcCalls("create_invitation").length + fake.rpcCalls("set_member_role").length, 0);
  });

  test("malformed input is 422 with fields; workspace ids in bodies are ignored, never used", async () => {
    const c = cookie(ownerA);
    const cases: [Response, string][] = [
      [await (patchMember as Handler)(req("/api/team/not-a-uuid", { cookie: c, method: "PATCH", body: { role: "admin" } }), params({ userId: "not-a-uuid" })), "userId"],
      [await (postInvitation as Handler)(req("/api/team/invitations", { cookie: c, method: "POST", body: { email: "nope", role: "employee" } }), params()), "email"],
      [await (postInvitation as Handler)(req("/api/team/invitations", { cookie: c, method: "POST", body: { email: "a@example.invalid", role: "platform_admin" } }), params()), "role"],
      [await (patchSettings as Handler)(req("/api/settings/workspace", { cookie: c, method: "PATCH", body: "{not json" }), params()), "body"],
      [await (patchSettings as Handler)(req("/api/settings/workspace", { cookie: c, method: "PATCH", body: [1, 2] }), params()), "body"],
      [await (patchSettings as Handler)(req("/api/settings/workspace", { cookie: c, method: "PATCH", body: { workspaceId: WS_B } }), params()), "body"],
      [await (patchSettings as Handler)(req("/api/settings/workspace", { cookie: c, method: "PATCH", body: { logo_path: "x" } }), params()), "body"],
      [await (putAi as Handler)(req("/api/settings/ai-receptionist", { cookie: c, method: "PUT", body: { enabled: true } }), params()), "enabled"],
      [await (getAudit as Handler)(req("/api/audit?limit=101", { cookie: c }), params()), "limit"],
      [await (getAudit as Handler)(req("/api/audit?cursor=garbage", { cookie: c }), params()), "cursor"],
    ];
    for (const [res, field] of cases) {
      const body = (await res.json()) as { code: string; fields?: Record<string, string> };
      assert.equal(res.status, 422, field);
      assert.equal(body.code, "validation_failed", field);
      assert.ok(body.fields && Object.keys(body.fields).length > 0, `${field}: fields present`);
    }
    assert.equal(fake.calls.some((x) => x.method === "PATCH"), false, "no write reached the database");
  });

  test("settings, integrations and audit read only the caller's workspace; secrets never leave", async () => {
    const c = cookie(ownerA);
    const s = await json(await (getSettings as Handler)(req("/api/settings/workspace", { cookie: c }), params()));
    assert.equal((s.body.settings as { businessName: string }).businessName, "Alpha Plumbing");
    const i = await json(await (getIntegrations as Handler)(req("/api/integrations", { cookie: c }), params()));
    assert.deepEqual(i.body.items, [{ provider: "calendar_sync", status: "disconnected", capabilities: [], verifiedAt: null,
      config: { region: "us" }, updatedAt: "2026-10-01T00:00:00Z" }]);
    assert.equal(JSON.stringify(i.body).includes("must-not-leak"), false);
    assert.equal(JSON.stringify([s.body, i.body]).toLowerCase().includes("bravo"), false);
  });

  test("audit is newest-first with an opaque cursor and no cross-workspace rows", async () => {
    const c = cookie(ownerA);
    const first = await json(await (getAudit as Handler)(req("/api/audit?limit=2", { cookie: c }), params()));
    assert.deepEqual((first.body.items as { id: number }[]).map((x) => x.id), [3, 2]);
    assert.equal((first.body.items as { actorName: string }[])[0].actorName, "Owner A");
    assert.equal(typeof first.body.nextCursor, "string");
    const second = await json(await (getAudit as Handler)(req(`/api/audit?limit=2&cursor=${first.body.nextCursor}`, { cookie: c }), params()));
    assert.deepEqual((second.body.items as { id: number }[]).map((x) => x.id), [1]);
    assert.equal(second.body.nextCursor, null);
    assert.equal(JSON.stringify([first.body, second.body]).includes("bravo"), false);
  });

  test("public invitation preview: format checked first, 404/410 states, masked email only, no-referrer", async () => {
    const bad = await json(await (peekRoute as Handler)(req("/api/invitations/short"), params({ token: "short" })));
    assert.deepEqual([bad.status, bad.body.code], [404, "invitation_not_found"]);
    assert.equal(fake.rpcCalls("peek_invitation").length, 0, "malformed tokens never reach the database");
    for (const status of ["expired", "used", "revoked"]) {
      fake.rpc.peek_invitation = () => ({ status: 200, body: { status, workspace_name: "Alpha", role: "employee", email_masked: "n***@example.invalid", account_exists: false } });
      const r = await json(await (peekRoute as Handler)(req(`/api/invitations/${TOKEN}`), params({ token: TOKEN })));
      assert.deepEqual([r.status, r.body.code], [410, `invitation_${status}`]);
    }
    fake.rpc.peek_invitation = () => ({ status: 200, body: { status: "valid", workspace_name: "Alpha", role: "admin", email_masked: "n***@example.invalid", account_exists: true } });
    const res = await (peekRoute as Handler)(req(`/api/invitations/${TOKEN}`), params({ token: TOKEN }));
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.deepEqual(await res.json(), { ok: true, workspaceName: "Alpha", role: "admin", emailMasked: "n***@example.invalid", accountExists: true });
    assert.ok(fake.rpcCalls("peek_invitation").every((x) => x.bearer === null || x.bearer === fake.anonKey), "previewed anonymously");
  });

  test("accepting without a session needs a password (401) and validates it (422) before creating anything", async () => {
    const none = await json(await (acceptRoute as Handler)(req(`/api/invitations/${TOKEN}/accept`, { method: "POST", body: {} }), params({ token: TOKEN })));
    assert.deepEqual([none.status, none.body.code], [401, "unauthenticated"]);
    const short = await json(await (acceptRoute as Handler)(req(`/api/invitations/${TOKEN}/accept`, { method: "POST", body: { password: "short" } }), params({ token: TOKEN })));
    assert.deepEqual([short.status, short.body.code], [422, "validation_failed"]);
    const extra = await json(await (acceptRoute as Handler)(req(`/api/invitations/${TOKEN}/accept`, { method: "POST", body: { password: "long-enough-password", email: "attacker@example.invalid" } }), params({ token: TOKEN })));
    assert.deepEqual([extra.status, extra.body.code], [422, "validation_failed"], "the client cannot choose the email");
    assert.equal(fake.calls.some((x) => x.path.startsWith("/auth/v1/admin")), false);
  });
});

describe("P4 legacy mode is unchanged", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.AUTH_PROVIDER;
    process.env.AUTH_PROVIDER = "legacy";
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.AUTH_PROVIDER;
    else process.env.AUTH_PROVIDER = prev;
  });

  test("every P4 endpoint answers 404 in legacy mode", async () => {
    const id = "00000000-0000-4000-8000-0000000a0001";
    const responses = [
      await getTeam(req("/api/team")), await getInvitations(req("/api/team/invitations")),
      await postInvitation(req("/api/team/invitations", { method: "POST", body: { email: "a@example.invalid", role: "employee" } })),
      await (patchMember as Handler)(req(`/api/team/${id}`, { method: "PATCH", body: { role: "admin" } }), params({ userId: id })),
      await (deleteMember as Handler)(req(`/api/team/${id}`, { method: "DELETE" }), params({ userId: id })),
      await (deleteInvitation as Handler)(req(`/api/team/invitations/${id}`, { method: "DELETE" }), params({ id })),
      await (peekRoute as Handler)(req(`/api/invitations/${TOKEN}`), params({ token: TOKEN })),
      await (acceptRoute as Handler)(req(`/api/invitations/${TOKEN}/accept`, { method: "POST", body: {} }), params({ token: TOKEN })),
      await getSettings(req("/api/settings/workspace")), await getAi(req("/api/settings/ai-receptionist")),
      await getIntegrations(req("/api/integrations")), await getAudit(req("/api/audit")), await getChecklist(req("/api/onboarding/checklist")),
    ];
    for (const r of responses) assert.equal(r.status, 404);
  });
});

describe("P4 static guards", () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (name === "route.ts") out.push(p);
    }
    return out;
  };
  const rel = (p: string) => relative(ROOT, p).split("\\").join("/");

  test("native-only routes go through nativeApi (permission + JWT) except the public invitation endpoints", () => {
    const native = ["team", "settings", "integrations", "audit", join("onboarding", "checklist")]
      .flatMap((d) => walk(join(ROOT, "src", "app", "api", d)));
    assert.ok(native.length >= 8);
    for (const f of native) {
      const src = readFileSync(f, "utf8");
      assert.match(src, /nativeApi\(req, \{ permission: "[a-z_]+\.[a-z_]+"/, `${rel(f)} must call nativeApi with a permission`);
      assert.equal(/supabase\/admin|SERVICE_ROLE/.test(src), false, `${rel(f)} must not use the service role`);
    }
    const publicRoutes = walk(join(ROOT, "src", "app", "api", "invitations")).map(rel).sort();
    assert.deepEqual(publicRoutes, ["src/app/api/invitations/[token]/accept/route.ts", "src/app/api/invitations/[token]/route.ts"]);
  });

  test("middleware protects every native API prefix (prefix list and matcher)", () => {
    const mw = readFileSync(join(ROOT, "src", "middleware.ts"), "utf8");
    for (const p of ["team", "settings", "integrations", "audit", "contacts", "pipeline", "opportunities", "calendars",
      "appointments", "conversations", "tasks", "reviews", "reports"]) {
      assert.ok(mw.includes(`"/api/${p}"`), `prefix /api/${p}`);
      assert.ok(mw.includes(`"/api/${p}/:path*"`), `matcher /api/${p}`);
    }
    assert.ok(mw.includes(`"/api/onboarding/checklist"`));
    assert.equal(/"\/api\/invitations|"\/invite/.test(mw), false, "invitation landing and preview stay public");
  });

  test("the invitation flow sends nothing: no mail, SMS, or outbound clients in P4 code", () => {
    const files = [
      ...walk(join(ROOT, "src", "app", "api", "team")), ...walk(join(ROOT, "src", "app", "api", "invitations")),
      ...readdirSync(join(ROOT, "src", "lib", "native")).map((f) => join(ROOT, "src", "lib", "native", f)),
      join(ROOT, "src", "lib", "supabase", "admin.ts"), join(ROOT, "src", "components", "settings", "NativeSettings.tsx"),
      join(ROOT, "src", "app", "invite", "[token]", "page.tsx"),
    ];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      assert.equal(/inviteUserByEmail|resend|twilio|nodemailer|sendgrid|signInWithOtp|generateLink|sms/i.test(src.replace(/no email or text|nothing is emailed|no email or SMS|or texted/gi, "")), false, rel(f));
    }
  });

  test("NET-1 guard (preloaded into the stack app) refuses and records non-local connections and allows loopback", () => {
    const dir = mkdtempSync(join(tmpdir(), "fna-net-guard-test-"));
    const log = join(dir, "outbound.jsonl");
    const script = [
      "const net = require('node:net');",
      "const server = net.createServer((s) => s.end()).listen(0, '127.0.0.1', () => {",
      "  const local = net.connect(server.address().port, '127.0.0.1', () => {",
      "    console.log('loopback ok'); local.end();",
      "    const raw = net.connect({ host: '203.0.113.7', port: 443 });",
      "    raw.on('error', (e) => {",
      "      console.log(e.message);",
      "      fetch('https://example.com/').then(() => console.log('fetch passed'), () => console.log('fetch refused'))",
      "        .finally(() => server.close());",
      "    });",
      "  });",
      "});",
    ].join("\n");
    const r = spawnSync(process.execPath, ["--require", join(ROOT, "tests", "helpers", "net-guard.cjs"), "-e", script], {
      env: { ...process.env, NET_GUARD_LOG: log }, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /loopback ok/);
    assert.match(r.stdout, /NET-1: outbound connection to 203\.0\.113\.7:443 refused/);
    assert.match(r.stdout, /fetch refused/);
    const hosts = readFileSync(log, "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l).host);
    assert.deepEqual(hosts, ["203.0.113.7", "example.com"]);
  });
});

describe("Settings permissions editor matches the database role tables", () => {
  test("employee base and overridable permissions agree with migration M2 and exclude team.* / integrations.manage", async () => {
    const { EMPLOYEE_BASE, OVERRIDABLE } = await import("../src/components/settings/NativeSettings");
    const m2 = readFileSync(join(__dirname, "..", "supabase", "migrations", "20261101000200_identity_platform.sql"), "utf8");
    const roleList = (role: string) => {
      const m = new RegExp(`select '${role}', p from unnest\\(array\\[([\\s\\S]*?)\\]\\)`).exec(m2);
      assert.ok(m, role);
      return [...m![1].matchAll(/'([a-z_.]+)'/g)].map((x) => x[1]);
    };
    assert.deepEqual([...EMPLOYEE_BASE].sort(), roleList("employee").sort());
    const owner = roleList("owner");
    for (const [perm] of OVERRIDABLE) {
      assert.ok(owner.includes(perm), `${perm} is a real permission`);
      assert.ok(!perm.startsWith("team.") && perm !== "integrations.manage", `${perm} may not be overridden`);
    }
    assert.equal(new Set(OVERRIDABLE.map(([p]) => p)).size, OVERRIDABLE.length);
  });
});
