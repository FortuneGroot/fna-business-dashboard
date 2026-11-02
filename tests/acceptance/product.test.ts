// Product-gap rehearsal on a fresh disposable Supabase stack: employee permission overrides, business
// hours, workspace logos (§6.6), the pipeline board beyond eight cards per stage, and logout across
// browser tabs (M21). Real browser → app → database; each person uses their own cookies. The
// superuser connection only registers the platform admin and verifies outcomes.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type pg from "pg";
import {
  adminDb, appFetch, appLogin, launchBrowser, readSessionCookie, rest, rpc, signUp, startApp, startStack, upgradeToAal2,
  type App, type Identity, type Stack, type StackEnv,
} from "../supabase-stack/stack";

const run = Date.now().toString(36);
const email = (who: string) => `${who}-${run}@example.test`;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

let stack: Stack;
let env: StackEnv;
let db: pg.Client;
let app: App;
let owner: Identity;
let employee: Identity;
let rival: Identity;
let ownerCookie = "";
let employeeCookie = "";
let rivalCookie = "";
let ws = "";
let rivalWs = "";

type Res = { status: number; body: any; text: string };
async function call(cookie: string, method: string, path: string, init: { json?: unknown; raw?: Buffer; type?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { cookie };
  let body: BodyInit | undefined;
  if (init.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  } else if (init.raw) {
    headers["content-type"] = init.type ?? "application/octet-stream";
    body = new Uint8Array(init.raw);
  }
  const res = await fetch(`${app.url}${path}`, { method, headers, body, redirect: "manual" });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, text };
}
const ok = async (p: Promise<Res>, label: string) => {
  const r = await p;
  assert.equal(r.status, 200, `${label}: ${r.text.slice(0, 300)}`);
  return r;
};

async function provision(platformAal2: string, key: string, name: string, who: Identity): Promise<string> {
  const prov = await rpc(env, platformAal2, "platform_provision_workspace", {
    p_provisioning_key: `synthetic-${key}-${run}`, p_name: name, p_slug: `${key}-${run}`, p_owner_email: who.email,
  });
  assert.equal(prov.status, 200, prov.text);
  assert.equal((await rpc(env, who.token, "accept_invitation", { p_token: prov.body.invite_token })).status, 200);
  return prov.body.workspace_id;
}

async function browserAs(person: Identity) {
  const browser = await launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  ctx.setDefaultTimeout(20_000);
  await ctx.addInitScript("window.__name = (f) => f");
  const base = app.url.replace("//127.0.0.1:", "//localhost:");
  const page = await ctx.newPage();
  await page.goto(`${base}/login`);
  await page.fill("#email", person.email);
  await page.fill("#password", person.password);
  await page.click("button[type=submit]");
  await page.waitForURL(/\/dashboard$/);
  return { browser, ctx, page, base };
}

describe("product rehearsal: overrides, business hours, logos, full board, logout across tabs", () => {
  before(async () => {
    stack = startStack();
    env = stack.env;
    db = await adminDb(env);
    app = await startApp(env);
    const platform = await signUp(env, email("platform"), "Product Platform Admin");
    await db.query("insert into public.platform_admins (user_id) values ($1)", [platform.id]);
    const platformAal2 = await upgradeToAal2(env, platform);
    owner = await signUp(env, email("owner"), "Olive Owner");
    rival = await signUp(env, email("rival"), "Rex Rival");
    ws = await provision(platformAal2, "lakeside", "Lakeside Landscaping (synthetic)", owner);
    rivalWs = await provision(platformAal2, "ridge", "Ridge Roofing (synthetic)", rival);
    ownerCookie = await appLogin(app, owner);
    rivalCookie = await appLogin(app, rival);
    employee = await signUp(env, email("employee"), "Evan Employee");
    const inv = await ok(call(ownerCookie, "POST", "/api/team/invitations", { json: { email: employee.email, role: "employee" } }), "invite");
    const token = String(inv.body.inviteUrl).split("/").pop()!;
    assert.equal((await rpc(env, employee.token, "accept_invitation", { p_token: token })).status, 200);
    employeeCookie = await appLogin(app, employee);
  });

  after(async () => {
    app?.stop();
    await db?.end().catch(() => undefined);
    stack?.stop();
  });

  test("overrides: the owner allows and denies employee permissions in Settings; they apply to the employee at once", async () => {
    const before = await ok(call(employeeCookie, "GET", "/api/auth/me"), "employee me");
    assert.equal(before.body.permissions.includes("contacts.delete"), false);
    assert.equal(before.body.permissions.includes("conversations.read"), true);

    const { browser, page, base } = await browserAs(owner);
    try {
      await page.goto(`${base}/settings`);
      await page.getByRole("button", { name: `Permissions for ${employee.email}` }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Delete contacts").selectOption("allow");
      await dialog.getByLabel("View the inbox").selectOption("deny");
      await dialog.getByRole("button", { name: "Save permissions" }).click();
      await page.getByRole("status").filter({ hasText: "Permissions updated" }).waitFor();
      await page.getByRole("button", { name: `Permissions for ${employee.email}` }).filter({ hasText: "(2)" }).waitFor();
    } finally {
      await browser.close();
    }
    const rows = await db.query<{ permission: string; allowed: boolean }>(
      "select permission, allowed from public.member_permission_overrides where workspace_id = $1 and user_id = $2 order by 1", [ws, employee.id]);
    assert.deepEqual(rows.rows, [{ permission: "contacts.delete", allowed: true }, { permission: "conversations.read", allowed: false }]);
    const after = await ok(call(employeeCookie, "GET", "/api/auth/me"), "employee me after");
    assert.equal(after.body.permissions.includes("contacts.delete"), true);
    assert.equal(after.body.permissions.includes("conversations.read"), false);
    assert.equal((await call(employeeCookie, "GET", "/api/conversations")).status, 403);
    const audit = await db.query("select 1 from public.workspace_audit_log where workspace_id = $1 and action = 'member.permission_override'", [ws]);
    assert.equal(audit.rowCount, 2, "each override change is audited");

    // The employee cannot change overrides (API refusal; the UI shows no control).
    const self = await call(employeeCookie, "PATCH", `/api/team/${employee.id}`, { json: { overrides: { "contacts.delete": true } } });
    assert.equal(self.status, 403, self.text);
    // Back to role defaults through the API contract the editor uses.
    await ok(call(ownerCookie, "PATCH", `/api/team/${employee.id}`, { json: { overrides: { "contacts.delete": null, "conversations.read": null } } }), "clear");
    assert.equal((await db.query("select 1 from public.member_permission_overrides where user_id = $1", [employee.id])).rowCount, 0);
  });

  test("business hours: the owner edits them in Settings; invalid hours are refused and nothing changes", async () => {
    const { browser, page, base } = await browserAs(owner);
    try {
      await page.goto(`${base}/settings`);
      const profile = page.getByRole("form", { name: "Business profile" });
      await profile.getByLabel("Monday", { exact: true }).check();
      await profile.getByLabel("Monday opens").fill("08:30");
      await profile.getByLabel("Monday closes").fill("16:00");
      await profile.getByLabel("Saturday", { exact: true }).check();
      await profile.getByRole("button", { name: "Save profile" }).click();
      await page.getByRole("status").filter({ hasText: "Business profile saved." }).waitFor();
      let row = (await db.query("select business_hours from public.workspace_settings where workspace_id = $1", [ws])).rows[0];
      assert.deepEqual(row.business_hours.mon, [{ start: "08:30", end: "16:00" }]);
      assert.deepEqual(row.business_hours.sat, [{ start: "09:00", end: "17:00" }]);
      assert.deepEqual(row.business_hours.sun, []);

      await profile.getByLabel("Monday closes").fill("07:00");
      await profile.getByRole("button", { name: "Save profile" }).click();
      await page.getByRole("alert").waitFor();
      row = (await db.query("select business_hours from public.workspace_settings where workspace_id = $1", [ws])).rows[0];
      assert.deepEqual(row.business_hours.mon, [{ start: "08:30", end: "16:00" }], "refused save changed nothing");
    } finally {
      await browser.close();
    }
    const asEmployee = await call(employeeCookie, "PATCH", "/api/settings/workspace", { json: { businessHours: { mon: [] } } });
    assert.equal(asEmployee.status, 403, "employees cannot edit hours");
  });

  test("logos: upload, signed display, type checks, replacement, removal, permissions, and isolation", async () => {
    const empty = await ok(call(ownerCookie, "GET", "/api/settings/logo"), "no logo");
    assert.equal(empty.body.logo, null);

    const up = await ok(call(ownerCookie, "PUT", "/api/settings/logo", { raw: PNG, type: "image/png" }), "upload png");
    assert.match(up.body.logo.url, /\/storage\/v1\/object\/sign\/workspace-assets\//);
    const img = await fetch(up.body.logo.url);
    assert.equal(img.status, 200);
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);
    assert.equal((await db.query("select logo_path from public.workspace_settings where workspace_id = $1", [ws])).rows[0].logo_path, `${ws}/logo.png`);

    for (const [raw, type, label] of [
      [Buffer.from("hello"), "text/plain", "wrong type"], [Buffer.from("not really a png"), "image/png", "spoofed type"],
      [Buffer.alloc(0), "image/png", "empty"], [Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]), "image/png", "too large"],
    ] as [Buffer, string, string][]) {
      const r = await call(ownerCookie, "PUT", "/api/settings/logo", { raw, type });
      assert.deepEqual([r.status, r.body?.code], [422, "validation_failed"], `${label}: ${r.text.slice(0, 200)}`);
    }

    // Employees read (settings.read) but cannot write; other businesses see only their own.
    assert.match((await ok(call(employeeCookie, "GET", "/api/settings/logo"), "employee read")).body.logo.url, /sign/);
    assert.equal((await call(employeeCookie, "PUT", "/api/settings/logo", { raw: PNG, type: "image/png" })).status, 403);
    assert.equal((await call(employeeCookie, "DELETE", "/api/settings/logo")).status, 403);
    assert.equal((await ok(call(rivalCookie, "GET", "/api/settings/logo"), "rival read")).body.logo, null);
    const rivalToken = readSessionCookie(rivalCookie).session.access_token;
    const direct = await fetch(`${env.apiUrl}/storage/v1/object/workspace-assets/${ws}/logo.png`, {
      headers: { apikey: env.anonKey, Authorization: `Bearer ${rivalToken}` },
    });
    assert.notEqual(direct.status, 200, "another business cannot read the object directly");
    await direct.body?.cancel();

    // Replacing with another format leaves exactly one logo object.
    await ok(call(ownerCookie, "PUT", "/api/settings/logo", { raw: JPEG, type: "image/jpeg" }), "upload jpeg");
    const objects = async () => (await db.query<{ name: string }>(
      "select name from storage.objects where bucket_id = 'workspace-assets' and name like $1 order by 1", [`${ws}/%`])).rows.map((r) => r.name);
    assert.deepEqual(await objects(), [`${ws}/logo.jpg`]);

    const { browser, page, base } = await browserAs(owner);
    try {
      await page.goto(`${base}/settings`);
      await page.getByRole("img", { name: "Business logo" }).waitFor();
      await page.locator("#biz-logo").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
      await page.getByRole("status").filter({ hasText: "Logo updated." }).waitFor();
      assert.deepEqual(await objects(), [`${ws}/logo.png`]);
      await page.waitForFunction(() => {
        const el = document.querySelector<HTMLImageElement>("img[alt='Business logo']");
        return Boolean(el && el.complete && el.naturalWidth > 0);
      });
      await page.getByRole("button", { name: "Remove logo" }).click();
      await page.getByRole("status").filter({ hasText: "Logo removed." }).waitFor();
    } finally {
      await browser.close();
    }
    assert.deepEqual(await objects(), []);
    assert.equal((await db.query("select logo_path from public.workspace_settings where workspace_id = $1", [ws])).rows[0].logo_path, null);
  });

  test("board: a stage with more than eight opportunities shows every one on demand, without duplicates", async () => {
    const pipeline = await ok(call(ownerCookie, "GET", "/api/pipeline"), "pipeline");
    const stage = pipeline.body.pipeline.stages[0] as { id: string; name: string };
    const contact = await ok(call(ownerCookie, "POST", "/api/contacts", { json: { firstName: "Board", lastName: "Customer" } }), "contact");
    for (let i = 1; i <= 20; i++) {
      await ok(call(ownerCookie, "POST", "/api/opportunities", {
        json: { contactId: contact.body.contact.id, stageId: stage.id, title: `Deal ${String(i).padStart(2, "0")}`, valueCents: i * 100 },
      }), `deal ${i}`);
    }
    const { browser, page, base } = await browserAs(owner);
    try {
      await page.goto(`${base}/pipeline`);
      const more = page.getByRole("button", { name: "Show 12 more" });
      await more.waitFor();
      await more.click();
      await page.getByText("Deal 01 ·").waitFor();
      const column = page.locator("li", { hasText: /^Deal \d\d ·/ });
      const titles = (await column.allTextContents()).map((t) => /Deal \d\d/.exec(t)![0]);
      assert.equal(titles.length, 12);
      assert.equal(new Set(titles).size, 12, "no duplicates of the eight already shown");
      assert.equal(await page.getByRole("button", { name: "Show more" }).count(), 0, "all loaded");
      const edits = await page.getByRole("button", { name: "Edit opportunity" }).count();
      assert.ok(edits >= 20, `every card is editable (${edits})`);

      // Editing a card loaded by "Show more" updates that list at once; it used to keep the old row.
      // Moving a deal out of the stage leaves the top eight as they are, so the list stays open.
      const dialog = page.getByRole("dialog");
      await page.locator("li", { hasText: /^Deal 02 ·/ }).getByRole("button", { name: "Edit opportunity" }).click();
      const other = pipeline.body.pipeline.stages[1] as { id: string };
      await dialog.locator("select").first().selectOption(other.id);
      await dialog.getByRole("button", { name: "Save" }).click();
      await page.locator("li", { hasText: /^Deal 02 ·/ }).waitFor({ state: "detached" });
      await page.waitForLoadState("networkidle");
      const after = (await page.locator("li", { hasText: /^Deal \d\d ·/ }).allTextContents()).map((t) => /Deal \d\d/.exec(t)![0]);
      assert.equal(after.length, 11, "the other eleven stay listed");
      assert.equal(new Set(after).size, after.length, "no duplicates after the move");
      assert.equal(after.includes("Deal 02"), false, "the moved deal left this stage's list");
      // A rename shows at once (a renamed deal can also join the top eight later, which resets the list).
      await page.locator("li", { hasText: /^Deal 01 ·/ }).getByRole("button", { name: "Edit opportunity" }).click();
      await dialog.getByRole("textbox", { name: "Title" }).fill("Deal 01 renamed");
      await dialog.getByRole("button", { name: "Save" }).click();
      await page.locator("li", { hasText: /^Deal 01 ·/ }).waitFor({ state: "detached" });
      assert.equal((await db.query("select 1 from public.opportunities where workspace_id = $1 and title = 'Deal 01 renamed'", [ws])).rowCount, 1);
    } finally {
      await browser.close();
    }
  });

  test("calendar: when availability fails after the calendar is created, Try again saves that calendar instead of a second one", async () => {
    const { browser, page, base } = await browserAs(owner);
    try {
      await page.goto(`${base}/calendar`);
      const saves: string[] = [];
      await page.route("**/api/calendars/*/availability", (route) => {
        saves.push(new URL(route.request().url()).pathname);
        return saves.length === 1
          ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Availability is temporarily unavailable.", code: "unavailable" }) })
          : route.continue();
      });
      await page.getByRole("button", { name: "Create calendar" }).first().click();
      const dialog = page.getByRole("dialog");
      await dialog.locator("#cal-name").fill("Retry chairs");
      await dialog.getByRole("button", { name: "Create calendar" }).click();
      // The first calendar changes the page layout; the error must stay on screen (it once vanished).
      await dialog.getByRole("alert").filter({ hasText: "Availability is temporarily unavailable." }).waitFor();
      await page.waitForLoadState("networkidle");
      assert.equal(await dialog.getByRole("alert").count(), 1, "the error is still shown");
      await dialog.getByRole("button", { name: "Create calendar" }).click();
      await dialog.waitFor({ state: "detached" });
      const cals = await db.query<{ id: string }>(
        "select id from public.calendars where workspace_id = $1 and name = 'Retry chairs'", [ws]);
      assert.equal(cals.rows.length, 1, "exactly one calendar");
      assert.deepEqual(saves, [`/api/calendars/${cals.rows[0].id}/availability`, `/api/calendars/${cals.rows[0].id}/availability`],
        "both availability saves went to the one calendar");
    } finally {
      await browser.close();
    }
  });

  test("logout across tabs: signing out in one tab ends the other tab and every replay at once", async () => {
    const { browser, ctx, page: tabA, base } = await browserAs(owner);
    try {
      const tabB = await ctx.newPage();
      await tabB.goto(`${base}/contacts`);
      await tabB.waitForURL(/\/contacts$/);
      const cookies = await ctx.cookies();
      const replay = cookies.filter((c) => /^sb-.+-auth-token/.test(c.name)).map((c) => `${c.name}=${c.value}`).join("; ");
      assert.ok(replay, "captured the session cookie");

      await tabA.getByRole("button", { name: "Sign out" }).click();
      await tabA.waitForURL(/\/login/);
      await tabB.reload();
      await tabB.waitForURL(/\/login/);
      const inPage = await tabB.evaluate(async () => (await fetch("/api/contacts")).status);
      assert.equal(inPage, 401);

      const read = await appFetch(app, "/api/contacts", { cookie: replay });
      const write = await appFetch(app, "/api/contacts", { method: "POST", cookie: replay, json: { firstName: "Ghost", lastName: "Write" } });
      assert.deepEqual([read.status, write.status], [401, 401]);
      const token = readSessionCookie(replay).session.access_token;
      assert.equal((await rest(env, token, "GET", "contacts?select=id")).status, 401);
      assert.equal((await db.query("select 1 from public.contacts where first_name = 'Ghost'")).rowCount, 0);
    } finally {
      await browser.close();
    }
    // The owner's other session (the API cookie used above) is unaffected.
    await ok(call(ownerCookie, "GET", "/api/contacts"), "other session");
  });
});
