// Hardening rehearsal on a fresh disposable Supabase stack: one person who owns two synthetic
// businesses, several browser tabs, workspace switches during loads and saves. Every app request
// uses that person's own cookies; the superuser connection only registers the platform admin and
// verifies outcomes.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type pg from "pg";
import {
  adminDb, appFetch, appLogin, launchBrowser, rpc, signUp, startApp, startStack, upgradeToAal2,
  type App, type Identity, type Stack, type StackEnv,
} from "../supabase-stack/stack";

const run = Date.now().toString(36);
const email = (who: string) => `${who}-${run}@example.test`;
const NORTH = "North Shore Dental (synthetic)";
const SOUTH = "South Bay Movers (synthetic)";

type R = Awaited<ReturnType<typeof appFetch>>;

let stack: Stack;
let env: StackEnv;
let db: pg.Client;
let app: App;
let platformAal2 = "";
let owner: Identity;
let ownerCookie = "";
let wsN = "";
let wsS = "";

const call = (method: string, path: string, json?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${app.url}${path}`, {
    method,
    headers: { cookie: ownerCookie, ...(json !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : undefined,
    redirect: "manual",
  }).then(async (res) => {
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body, text } as Pick<R, "status" | "body" | "text">;
  });
const ok = async <T extends { status: number; text: string }>(p: Promise<T>, label: string) => {
  const r = await p;
  assert.equal(r.status, 200, `${label}: ${r.text.slice(0, 300)}`);
  return r;
};
const pin = (ws: string) => ({ "x-fna-workspace": ws });
const switchTo = (ws: string) => ok(call("POST", "/api/workspaces/active", { workspaceId: ws }), `switch to ${ws}`);
const contactNames = async (ws: string) =>
  (await db.query<{ name: string }>(
    "select trim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')) name from public.contacts where workspace_id = $1 and deleted_at is null order by 1", [ws])).rows.map((r) => r.name);

describe("hardening rehearsal: two synthetic businesses, one owner, many tabs", () => {
  before(async () => {
    stack = startStack();
    env = stack.env;
    db = await adminDb(env);
    app = await startApp(env);
    const platform = await signUp(env, email("platform"), "Hardening Platform Admin");
    await db.query("insert into public.platform_admins (user_id) values ($1)", [platform.id]);
    platformAal2 = await upgradeToAal2(env, platform);
    owner = await signUp(env, email("owner"), "Morgan Two-Business");
    for (const [name, key] of [[NORTH, "north"], [SOUTH, "south"]] as const) {
      const prov = await rpc(env, platformAal2, "platform_provision_workspace", {
        p_provisioning_key: `synthetic-${key}-${run}`, p_name: name, p_slug: `${key}-${run}`, p_owner_email: owner.email,
      });
      assert.equal(prov.status, 200, prov.text);
      assert.equal((await rpc(env, owner.token, "accept_invitation", { p_token: prov.body.invite_token })).status, 200);
      if (key === "north") wsN = prov.body.workspace_id;
      else wsS = prov.body.workspace_id;
    }
    ownerCookie = await appLogin(app, owner);
    await switchTo(wsN);
    for (const n of ["Nora North", "Nate North"]) {
      const [first, last] = n.split(" ");
      await ok(call("POST", "/api/contacts", { firstName: first, lastName: last }), `seed ${n}`);
    }
    await switchTo(wsS);
    for (const n of ["Sam South", "Sue South"]) {
      const [first, last] = n.split(" ");
      await ok(call("POST", "/api/contacts", { firstName: first, lastName: last }), `seed ${n}`);
    }
  });

  after(async () => {
    app?.stop();
    await db?.end().catch(() => undefined);
    stack?.stop();
  });

  describe("packet 1: workspace switching across tabs", () => {
    test("a request pinned to the previous business is refused (409 workspace_changed) and writes nothing", async () => {
      await switchTo(wsN);
      const north = await ok(call("GET", "/api/contacts?limit=1", undefined, pin(wsN)), "pinned read in the active business");
      assert.equal(north.body.items.length, 1);
      const cursor = north.body.nextCursor as string;
      assert.ok(cursor, "a second page exists");
      const northContact = north.body.items[0].id as string;

      await switchTo(wsS);
      const before = { n: await contactNames(wsN), s: await contactNames(wsS) };
      for (const [method, path, json] of [
        ["GET", "/api/contacts?limit=50"], ["GET", `/api/contacts?limit=1&cursor=${encodeURIComponent(cursor)}`],
        ["POST", "/api/contacts", { firstName: "Stale", lastName: "Create" }],
        ["PATCH", `/api/contacts/${northContact}`, { firstName: "Stale" }],
        ["POST", "/api/tasks", { title: "Stale task" }], ["PATCH", "/api/settings/workspace", { businessName: "Stale rename" }],
        ["GET", "/api/dashboard/summary"], ["GET", "/api/tenant/config"],
      ] as [string, string, unknown?][]) {
        const r = await call(method, path, json, pin(wsN));
        assert.deepEqual([r.status, r.body?.code], [409, "workspace_changed"], `${method} ${path}: ${r.text.slice(0, 200)}`);
        assert.doesNotMatch(r.text, /South|North/, "the refusal names no business");
      }
      assert.deepEqual({ n: await contactNames(wsN), s: await contactNames(wsS) }, before, "nothing was written in either business");
      const tasks = await db.query("select 1 from public.tasks where title = 'Stale task'");
      assert.equal(tasks.rowCount, 0);

      // Session-level routes are not workspace-pinned: listing, switching, and identity still answer.
      await ok(call("GET", "/api/workspaces", undefined, pin(wsN)), "workspace list");
      await ok(call("GET", "/api/auth/me", undefined, pin(wsN)), "me");
      // A pin matching the active business passes; no pin (API clients) uses the session as before.
      const south = await ok(call("GET", "/api/contacts?limit=50", undefined, pin(wsS)), "pinned to the active business");
      assert.deepEqual(south.body.items.map((c: { name: string }) => c.name).sort(), ["Sam South", "Sue South"]);
      // An old cursor replayed without a pin only ever pages the active business.
      const replay = await ok(call("GET", `/api/contacts?limit=1&cursor=${encodeURIComponent(cursor)}`), "unpinned cursor replay");
      for (const c of replay.body.items as { name: string }[]) assert.match(c.name, /South$/);
    });

    test("browser: two tabs, switching in one; the other cannot show or save the previous business", async () => {
      const shots = mkdtempSync(join(tmpdir(), "fna-tabs-"));
      const base = app.url.replace("//127.0.0.1:", "//localhost:");
      await switchTo(wsN);
      const browser = await launchBrowser();
      try {
        const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
        ctx.setDefaultTimeout(20_000);
        await ctx.addInitScript("window.__name = (f) => f");
        const tabA = await ctx.newPage();
        await tabA.goto(`${base}/login`);
        await tabA.fill("#email", owner.email);
        await tabA.fill("#password", owner.password);
        await tabA.click("button[type=submit]");
        await tabA.waitForURL(/\/dashboard$/);
        await tabA.goto(`${base}/contacts`);
        await tabA.getByRole("button", { name: "Open Nora North" }).waitFor();
        const tabB = await ctx.newPage();
        await tabB.goto(`${base}/contacts`);
        await tabB.getByRole("button", { name: "Open Nora North" }).waitFor();

        // The switcher is visible to a two-business owner and lists both businesses.
        const picker = tabB.locator("#topbar-workspace-select");
        await picker.waitFor();
        assert.deepEqual((await picker.locator("option").allTextContents()).sort(), [NORTH, SOUTH].sort());
        assert.equal(await tabB.getByLabel("Business").inputValue(), wsN);

        // Tab A opens the add form and holds its save in flight while tab B switches.
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        let held = false;
        await tabA.route("**/api/contacts", async (route) => {
          if (route.request().method() === "POST" && !held) {
            held = true;
            await gate;
          }
          await route.continue();
        });
        await tabA.getByRole("button", { name: "Add a contact" }).click();
        const dialog = tabA.getByRole("dialog");
        await dialog.locator("#c-first").fill("Held");
        await dialog.locator("#c-last").fill("Northsave");
        await dialog.getByRole("button", { name: "Add contact", exact: true }).click();
        while (!held) await new Promise((r) => setTimeout(r, 50));

        await picker.selectOption({ label: SOUTH });
        await tabB.waitForURL(/\/dashboard$/);
        await tabB.waitForLoadState("networkidle");
        assert.equal(await tabB.getByLabel("Business").inputValue(), wsS, "tab B now shows the new business");
        await tabB.goto(`${base}/contacts`);
        await tabB.getByRole("button", { name: "Open Sam South" }).waitFor();
        assert.equal(await tabB.getByRole("button", { name: "Open Nora North" }).count(), 0);

        release();
        await tabA.getByRole("alert").filter({ hasText: "switched to a different business in another tab" }).first().waitFor();
        assert.equal(await dialog.locator("#c-first").inputValue(), "Held", "the unsaved input stays in the form");
        await tabA.screenshot({ path: join(shots, "tab-a-stale.png"), fullPage: true });
        assert.deepEqual(await contactNames(wsS), ["Sam South", "Sue South"], "the held save did not land in the new business");
        assert.deepEqual(await contactNames(wsN), ["Nate North", "Nora North"], "nor in the previous one");

        // Searching in the stale tab does not pull the new business's records into the old screen.
        await tabA.getByRole("button", { name: "Close dialog" }).click();
        await tabA.fill("#contact-search", "South");
        await tabA.waitForTimeout(800);
        assert.equal(await tabA.getByRole("button", { name: "Open Sam South" }).count(), 0, "no South record in the North tab");

        // In-app navigation in the stale tab keeps the warning; a reload adopts the active business.
        await tabA.getByRole("link", { name: "Tasks" }).first().click();
        await tabA.waitForURL(/\/tasks$/);
        await tabA.getByRole("alert").filter({ hasText: "switched to a different business in another tab" }).first().waitFor();
        await tabA.reload();
        await tabA.waitForLoadState("networkidle");
        assert.equal(await tabA.getByRole("alert").filter({ hasText: "another tab" }).count(), 0, "a reload clears the warning");
        assert.equal(await tabA.getByLabel("Business").inputValue(), wsS);

        // Back and forward in tab B never show the previous business's records as current.
        await tabB.goBack();
        await tabB.waitForLoadState("networkidle");
        await tabB.goBack();
        await tabB.waitForLoadState("networkidle");
        const northVisible = await tabB.getByRole("button", { name: "Open Nora North" }).count();
        const warned = await tabB.getByRole("alert").filter({ hasText: "another tab" }).count();
        assert.ok(northVisible === 0 || warned > 0, "after Back, North records appear only under the stale-tab warning");
        await tabB.goForward();
        await tabB.waitForLoadState("networkidle");
        await tabB.screenshot({ path: join(shots, "tab-b-forward.png"), fullPage: true });
        console.log(`packet 1 screenshots: ${shots}`);
      } catch (err) {
        let n = 0;
        for (const c of browser.contexts()) {
          for (const p of c.pages()) await p.screenshot({ path: join(shots, `failure-${n++}.png`), fullPage: true }).catch(() => undefined);
        }
        console.error(`packet 1 browser flow failed (screenshots: ${shots})`);
        throw err;
      } finally {
        await browser.close().catch(() => undefined);
      }
    });
  });
});
