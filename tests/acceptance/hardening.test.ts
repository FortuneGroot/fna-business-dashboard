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
  adminDb, appFetch, appLogin, launchBrowser, readSessionCookie, rpc, sessionCookie, signUp, stackService, startApp, startStack, waitForService,
  upgradeToAal2, upgradeToAal2Session, type App, type Identity, type Stack, type StackEnv,
} from "../supabase-stack/stack";

const run = Date.now().toString(36);
const email = (who: string) => `${who}-${run}@example.test`;
const NORTH = "North Shore Dental (synthetic)";
const SOUTH = "South Bay Movers (synthetic)";
const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

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

        // A Settings page left open while another tab switches refuses a logo upload like every other
        // write (the upload once skipped the pin and wrote to the newly active business).
        const logos = async () => (await db.query<{ n: number }>(
          "select count(*)::int n from storage.objects where bucket_id = 'workspace-assets' and (name like $1 or name like $2)",
          [`${wsN}/%`, `${wsS}/%`])).rows[0].n;
        await tabA.goto(`${base}/settings`);
        await tabA.locator("#biz-logo").waitFor();
        const logosBefore = await logos();
        await tabB.getByLabel("Business").selectOption({ label: NORTH });
        // Tab B may already be on /dashboard, so wait for the switch itself rather than the URL.
        const switched = async () => (await db.query(
          "select 1 from public.user_active_workspace where user_id = $1 and workspace_id = $2", [owner.id, wsN])).rowCount === 1;
        for (let i = 0; i < 100 && !(await switched()); i++) await new Promise((r) => setTimeout(r, 100));
        assert.ok(await switched(), "tab B's switch reached the database");
        await tabB.waitForLoadState("networkidle");
        await tabA.locator("#biz-logo").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: Buffer.from(ONE_PIXEL_PNG, "base64") });
        const logoField = tabA.getByRole("group", { name: "Business logo" });
        await logoField.getByRole("alert").filter({ hasText: "Reload this page to continue" }).waitFor();
        assert.equal(await logoField.getByText("Logo updated.").count(), 0);
        assert.equal(await tabA.locator("#biz-logo").isDisabled(), false, "the upload control is usable again after the refusal");
        assert.equal(await logos(), logosBefore, "no logo was written to either business");
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

  describe("packet 2: bookings across time zones", () => {
    const calendars: Record<string, string> = {};
    const contacts: Record<string, string> = {};
    const book = (calendar: string, startsAt: string, endsAt: string, who = "nora") =>
      call("POST", "/api/appointments", { calendarId: calendars[calendar], contactId: contacts[who], startsAt, endsAt });
    const stored = async (id: string) =>
      (await db.query<{ s: string; e: string; calendar_id: string; workspace_id: string }>(
        `select to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"') s, to_char(ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"') e,
                calendar_id, workspace_id from public.appointments where id = $1`, [id])).rows[0];

    before(async () => {
      for (const [ws, rows] of [
        [wsN, [["chairs", "North chairs", "America/New_York"], ["sydney", "North Sydney clinic", "Australia/Sydney"]]],
        [wsS, [["trucks", "South trucks", "America/Los_Angeles"]]],
      ] as const) {
        await switchTo(ws);
        for (const [key, name, timezone] of rows) {
          const r = await ok(call("POST", "/api/calendars", { name, slug: key, timezone, durationMinutes: 60 }), `calendar ${name}`);
          calendars[key] = r.body.calendar?.id;
          assert.ok(calendars[key], r.text);
        }
      }
      const people = await db.query<{ id: string; first_name: string }>("select id, first_name from public.contacts where first_name in ('Nora','Nate','Sam')");
      for (const p of people.rows) contacts[p.first_name.toLowerCase()] = p.id;
    });

    test("saved instants are exact across DST, midnight, and month boundaries; overlaps are refused with a clear message", async () => {
      await switchTo(wsN);
      // US spring-forward (2031-03-09): 01:30 EST to 03:30 EDT is one real hour.
      const spring = await ok(book("chairs", "2031-03-09T01:30:00-05:00", "2031-03-09T03:30:00-04:00"), "spring-forward booking");
      assert.deepEqual(await stored(spring.body.appointment.id), { s: "2031-03-09T06:30Z", e: "2031-03-09T07:30Z", calendar_id: calendars.chairs, workspace_id: wsN });
      const clash = await book("chairs", "2031-03-09T03:00:00-04:00", "2031-03-09T03:45:00-04:00", "nate");
      assert.deepEqual([clash.status, clash.body?.code], [409, "overlap"], clash.text);
      assert.match(clash.body.error, /overlaps another booking on the same calendar/);
      // Bookings are half-open: one may start exactly when the previous ends.
      await ok(book("chairs", "2031-03-09T03:30:00-04:00", "2031-03-09T04:00:00-04:00", "nate"), "adjacent booking");
      // The same instant on another calendar (different zone) is allowed.
      await ok(book("sydney", "2031-03-09T17:30:00+11:00", "2031-03-09T18:30:00+11:00"), "same instant, Sydney calendar");

      // US fall-back (2031-11-02): 01:30 happens twice; both real instants are separate, bookable slots.
      const first = await ok(book("chairs", "2031-11-02T01:30:00-04:00", "2031-11-02T01:59:00-04:00"), "first 01:30");
      const second = await ok(book("chairs", "2031-11-02T01:30:00-05:00", "2031-11-02T01:59:00-05:00", "nate"), "second 01:30");
      assert.equal((await stored(first.body.appointment.id)).s, "2031-11-02T05:30Z");
      assert.equal((await stored(second.body.appointment.id)).s, "2031-11-02T06:30Z");

      // Across local midnight and a month end.
      const late = await ok(book("chairs", "2031-01-31T23:30:00-05:00", "2031-02-01T00:30:00-05:00"), "midnight/month booking");
      assert.deepEqual(await stored(late.body.appointment.id), { s: "2031-02-01T04:30Z", e: "2031-02-01T05:30Z", calendar_id: calendars.chairs, workspace_id: wsN });
      const ids = async (from: string, to: string) =>
        ((await ok(call("GET", `/api/appointments?calendarId=${calendars.chairs}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`), "range"))
          .body.items as { id: string }[]).map((a) => a.id);
      assert.ok((await ids("2031-01-31T00:00:00-05:00", "2031-02-01T00:00:00-05:00")).includes(late.body.appointment.id), "listed on the local day it starts");
      assert.ok((await ids("2031-02-01T00:00:00-05:00", "2031-02-02T00:00:00-05:00")).includes(late.body.appointment.id), "and on the local day it ends");
      assert.ok(!(await ids("2031-01-31T00:00:00Z", "2031-02-01T00:00:00Z")).includes(late.body.appointment.id), "not on the UTC day before it starts");

      // Every appointment stays attached to its exact calendar; filters never mix calendars or businesses.
      const sydney = await ok(call("GET", `/api/appointments?calendarId=${calendars.sydney}`), "sydney list");
      assert.ok(sydney.body.items.length >= 1);
      for (const a of sydney.body.items as { calendarId: string }[]) assert.equal(a.calendarId, calendars.sydney);
      const all = await ok(call("GET", "/api/appointments"), "all");
      const allIds = (all.body.items as { id: string }[]).map((a) => a.id);
      assert.equal(new Set(allIds).size, allIds.length, "no appointment listed twice");
      await switchTo(wsS);
      const crossed = await call("POST", "/api/appointments", { calendarId: calendars.chairs, contactId: contacts.sam, startsAt: "2031-05-01T10:00:00Z", endsAt: "2031-05-01T11:00:00Z" });
      assert.equal(crossed.status, 422, "another business's calendar cannot be booked");
      assert.equal((await ok(call("GET", "/api/appointments"), "south list")).body.items.length, 0, "North bookings never appear in South");
    });

    test("simultaneous requests for one slot: exactly one succeeds; edits and cancellations keep the rules", async () => {
      await switchTo(wsN);
      let winner = "";
      const rounds = 6 + Number(process.env.HARDENING_BOOKING_ROUNDS ?? 0);
      for (let i = 0; i < rounds; i++) {
        const date = i === 0 ? "2031-06-10" : new Date(Date.UTC(2032, 0, i)).toISOString().slice(0, 10);
        const attempts = await Promise.all(
          ["nora", "nate", "nora", "nate", "nora", "nate", "nora", "nate"].map((who) => book("chairs", `${date}T14:00:00Z`, `${date}T15:00:00Z`, who))
        );
        const diagnostics = app.log().split(/\r?\n/).filter((l) => l.includes("[native-api]")).slice(-5).join("\n");
        assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 409, 409, 409, 409, 409, 409, 409],
          `${date}: ${attempts.map((r) => r.text.slice(0, 80)).join("\n")}\n${diagnostics}`);
        for (const r of attempts.filter((x) => x.status === 409)) assert.equal(r.body.code, "overlap");
        const live = await db.query("select 1 from public.appointments where calendar_id = $1 and starts_at = $2", [calendars.chairs, `${date}T14:00:00Z`]);
        assert.equal(live.rowCount, 1, "one booking stored");
        if (i === 0) winner = attempts.find((r) => r.status === 200)!.body.appointment.id as string;
      }

      const a = (await ok(book("chairs", "2031-06-11T15:00:00Z", "2031-06-11T16:00:00Z"), "A")).body.appointment.id as string;
      const b = (await ok(book("chairs", "2031-06-11T16:00:00Z", "2031-06-11T17:00:00Z", "nate"), "B")).body.appointment.id as string;
      const moves = await Promise.all([a, b].map((id) =>
        call("PATCH", `/api/appointments/${id}`, { startsAt: "2031-06-11T18:00:00Z", endsAt: "2031-06-11T19:00:00Z" })));
      assert.deepEqual(moves.map((r) => r.status).sort(), [200, 409], "two simultaneous reschedules into one slot: one wins");

      const into = await call("PATCH", `/api/appointments/${winner}`, { startsAt: "2031-06-11T18:30:00Z", endsAt: "2031-06-11T19:30:00Z" });
      assert.deepEqual([into.status, into.body?.code], [409, "overlap"]);
      for (const [patch, field] of [
        [{ startsAt: "2031-06-10T14:00:00Z", endsAt: "2031-06-11T20:00:00Z" }, "endsAt"],
        [{ endsAt: "2031-06-11T15:00:01Z" }, "endsAt"],
        [{ endsAt: "2031-06-10T13:00:00Z" }, "endsAt"],
      ] as const) {
        const r = await call("PATCH", `/api/appointments/${winner}`, patch);
        assert.equal(r.status, 422, `${JSON.stringify(patch)}: ${r.text.slice(0, 200)}`);
        assert.ok(r.body.fields?.[field] || r.body.details?.[field] || /24 hours|after start/.test(r.text), r.text);
      }
      assert.deepEqual(await stored(winner), { s: "2031-06-10T14:00Z", e: "2031-06-10T15:00Z", calendar_id: calendars.chairs, workspace_id: wsN }, "refused edits changed nothing");

      // Cancelling frees the slot; restoring the cancelled booking into a taken slot is refused.
      await ok(call("PATCH", `/api/appointments/${winner}`, { status: "cancelled" }), "cancel");
      const rebook = await ok(book("chairs", "2031-06-10T14:00:00Z", "2031-06-10T15:00:00Z", "nate"), "rebook freed slot");
      const restore = await call("PATCH", `/api/appointments/${winner}`, { status: "booked" });
      assert.deepEqual([restore.status, restore.body?.code], [409, "overlap"]);
      assert.equal((await stored(rebook.body.appointment.id)).calendar_id, calendars.chairs);
    });

    test("browser in Los Angeles: local entry, UTC display labelled, skipped DST time refused, saves persist", async () => {
      const shots = mkdtempSync(join(tmpdir(), "fna-tz-"));
      const base = app.url.replace("//127.0.0.1:", "//localhost:");
      await switchTo(wsS);
      const browser = await launchBrowser();
      try {
        const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: "America/Los_Angeles" });
        ctx.setDefaultTimeout(20_000);
        await ctx.addInitScript("window.__name = (f) => f");
        const page = await ctx.newPage();
        await page.goto(`${base}/login`);
        await page.fill("#email", owner.email);
        await page.fill("#password", owner.password);
        await page.click("button[type=submit]");
        await page.waitForURL(/\/dashboard$/);
        await page.goto(`${base}/calendar`);
        await page.getByRole("button", { name: "Book appointment" }).first().click();
        const dialog = page.getByRole("dialog");
        await dialog.locator("#appt-calendar").selectOption({ label: "South trucks" });
        await dialog.locator("#appt-contact-search").fill("Sam");
        await dialog.locator("#appt-contact option", { hasText: "Sam South" }).waitFor({ state: "attached" });
        await dialog.locator("#appt-contact").selectOption({ label: "Sam South" });

        // 02:30 on 2031-03-09 does not exist in Los Angeles; the browser would silently save 03:30.
        await dialog.locator("#appt-start").fill("2031-03-09T02:30");
        await dialog.locator("#appt-end").fill("2031-03-09T04:00");
        await dialog.getByRole("button", { name: "Book appointment" }).click();
        await dialog.getByRole("alert").filter({ hasText: "does not exist in your time zone" }).waitFor();
        assert.equal((await db.query("select 1 from public.appointments where calendar_id = $1", [calendars.trucks])).rowCount, 0, "nothing saved");

        // 23:30 local on 31 Jan is 07:30 UTC on 1 Feb; the end is filled from the calendar duration.
        await dialog.locator("#appt-start").fill("2031-01-31T23:30");
        assert.equal(await dialog.locator("#appt-end").inputValue(), "2031-02-01T00:30");
        await dialog.getByRole("button", { name: "Book appointment" }).click();
        await dialog.waitFor({ state: "detached" });
        const row = (await db.query<{ id: string; s: string }>(
          `select id, to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') s from public.appointments where calendar_id = $1`, [calendars.trucks])).rows;
        assert.deepEqual(row.map((r) => r.s), ["2031-02-01 07:30"]);

        await page.reload();
        const card = page.locator(".card", { hasText: "South trucks" });
        await card.getByText("booked · 2031-02-01 07:30 UTC").waitFor();
        assert.equal(await card.getByRole("button", { name: "Edit appointment" }).count(), 1, "shown once");
        assert.equal(await page.getByText("2031-02-01 07:30 UTC").count(), 1, "not duplicated on another calendar");

        // The edit form shows the same local time that was entered, and a reschedule saves the exact instant.
        await card.getByRole("button", { name: "Edit appointment" }).click();
        const edit = page.getByRole("dialog");
        assert.equal(await edit.getByLabel("Starts (your local time)").inputValue(), "2031-01-31T23:30");
        await edit.getByLabel("Starts (your local time)").fill("2031-03-09T03:00");
        await edit.getByLabel("Ends (your local time)").fill("2031-03-09T04:00");
        await edit.getByRole("button", { name: "Save appointment" }).click();
        await edit.waitFor({ state: "detached" });
        await page.reload();
        await card.getByText("booked · 2031-03-09 10:00 UTC").waitFor();
        await page.screenshot({ path: join(shots, "calendar-la.png"), fullPage: true });
        console.log(`packet 2 screenshots: ${shots}`);
      } catch (err) {
        for (const c of browser.contexts()) {
          for (const [i, p] of c.pages().entries()) await p.screenshot({ path: join(shots, `failure-${i}.png`), fullPage: true }).catch(() => undefined);
        }
        console.error(`packet 2 browser flow failed (screenshots: ${shots})`);
        throw err;
      } finally {
        await browser.close().catch(() => undefined);
      }
    });
  });

  describe("packet 3: real-browser usability and accessibility", () => {
    const LONG_FIRST = "Maximiliana-Alexandrina Josephine";
    const LONG_LAST = "Featherstonehaugh-Worthington of the Very Long Synthetic Surname Family";
    const PAGES = ["/dashboard", "/contacts", "/pipeline", "/calendar", "/tasks", "/inbox", "/settings"];

    before(async () => {
      await switchTo(wsN);
      await ok(call("POST", "/api/contacts", { firstName: LONG_FIRST, lastName: LONG_LAST, tags: ["synthetic-long"] }), "long-name contact");
      await ok(call("POST", "/api/tasks", { title: `Follow up with ${LONG_FIRST} ${LONG_LAST} about the very long synthetic treatment plan` }), "long task");
    });

    async function login(width: number, height: number) {
      const browser = await launchBrowser();
      const ctx = await browser.newContext({ viewport: { width, height } });
      ctx.setDefaultTimeout(20_000);
      await ctx.addInitScript("window.__name = (f) => f");
      const page = await ctx.newPage();
      const base = app.url.replace("//127.0.0.1:", "//localhost:");
      await page.goto(`${base}/login`);
      await page.fill("#email", owner.email);
      await page.fill("#password", owner.password);
      await page.click("button[type=submit]");
      await page.waitForURL(/\/dashboard$/);
      return { browser, page, base };
    }
    const unlabelled = (page: import("playwright-core").Page) =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>("input, select, textarea, button")]
          .filter((el) => (el as HTMLInputElement).type !== "hidden" && el.getClientRects().length > 0)
          .filter((el) => {
            const named = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.getAttribute("title");
            if (el.tagName === "BUTTON") return !named && !el.textContent?.trim();
            return !named && !((el as HTMLInputElement).labels?.length);
          })
          .map((el) => el.id || el.outerHTML.slice(0, 100))
      );
    const overflow = (page: import("playwright-core").Page) =>
      page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    for (const [label, width, height] of [["desktop", 1360, 900], ["mobile", 390, 700]] as const) {
      test(`${label} (${width}px): labels, no sideways scrolling, long names, keyboard dialogs, errors in view, saves persist`, async () => {
        const shots = mkdtempSync(join(tmpdir(), `fna-a11y-${label}-`));
        await switchTo(wsN);
        const { browser, page, base } = await login(width, height);
        try {
          for (const path of PAGES) {
            await page.goto(`${base}${path}`);
            await page.waitForLoadState("networkidle");
            assert.deepEqual(await unlabelled(page), [], `${path}: every control has an accessible name`);
            assert.ok((await overflow(page)) <= 1, `${path}: no sideways scrolling at ${width}px (overflow ${await overflow(page)}px)`);
          }
          await page.goto(`${base}/contacts`);
          await page.getByRole("button", { name: `Open ${LONG_FIRST} ${LONG_LAST}` }).waitFor();
          await page.screenshot({ path: join(shots, "contacts-long-name.png"), fullPage: true });

          if (label === "mobile") {
            // The closed off-canvas menu is out of the tab order; the menu opens and closes by keyboard.
            const hiddenFocusable = await page.evaluate(() =>
              [...document.querySelectorAll<HTMLElement>("#app-sidebar a, #app-sidebar button")].filter((el) => {
                const r = el.getBoundingClientRect();
                return r.right <= 0 && getComputedStyle(el).visibility !== "hidden";
              }).length);
            assert.equal(hiddenFocusable, 0, "no invisible sidebar link can take keyboard focus");
            await page.getByRole("button", { name: "Open menu" }).focus();
            await page.keyboard.press("Enter");
            await page.getByRole("link", { name: "Tasks" }).first().waitFor({ state: "visible" });
            await page.keyboard.press("Escape");
            await page.waitForFunction(() => getComputedStyle(document.querySelector("#app-sidebar")!).visibility === "hidden");
          }

          // Keyboard: open the add dialog, focus lands on the first field, Tab stays inside, Escape returns focus.
          const add = page.getByRole("button", { name: "Add a contact" });
          await add.focus();
          await page.keyboard.press("Enter");
          const dialog = page.getByRole("dialog", { name: "Add a contact" });
          await dialog.waitFor();
          assert.equal(await page.evaluate(() => document.activeElement?.id), "c-first", "focus moves to the first field");
          for (let i = 0; i < 14; i++) await page.keyboard.press("Tab");
          assert.ok(await dialog.evaluate((d) => d.contains(document.activeElement)), "Tab keeps focus inside the dialog");
          assert.notEqual(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle), "none", "the focused control shows a focus ring");
          await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "detached" });
          assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Add a contact", "focus returns to the opener");

          // A rejected save shows its reason inside the dialog (not behind it) and keeps what was typed.
          await add.click();
          await dialog.locator("#c-first").fill("Valid");
          await dialog.locator("#c-last").fill("Person");
          const typedEmail = `synthetic-${label}-${run}@example.test`;
          await dialog.locator("#c-email").fill(typedEmail);
          await page.route("**/api/contacts", (route) =>
            route.request().method() === "POST"
              ? route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ ok: false, code: "validation_failed", error: "Some fields are invalid", fields: { email: "Enter a valid email" } }) })
              : route.continue());
          // The form fits a short screen: its submit button can be scrolled into view and pressed.
          const submit = dialog.getByRole("button", { name: "Add contact", exact: true });
          await submit.scrollIntoViewIfNeeded();
          const box = await submit.boundingBox();
          assert.ok(box && box.y >= 0 && box.y + box.height <= height, `submit reachable at ${width}x${height} (y=${box?.y})`);
          await submit.click();
          const inDialog = dialog.getByRole("alert");
          await inDialog.waitFor();
          assert.match(await inDialog.innerText(), /valid email|invalid/i);
          await page.waitForTimeout(300);
          const alertBox = await inDialog.boundingBox();
          assert.ok(alertBox && alertBox.y >= 0 && alertBox.y < height, `the error is on screen, on top of the page (y=${alertBox?.y})`);
          assert.equal(await dialog.locator("#c-email").inputValue(), typedEmail, "input kept after a failed save");
          await page.screenshot({ path: join(shots, "dialog-error.png") });
          await page.unroute("**/api/contacts");

          await dialog.locator("#c-first").fill(`Saved${label}`);
          await submit.click();
          await dialog.waitFor({ state: "detached" });
          await page.getByRole("status").filter({ hasText: `Saved${label} Person was added.` }).waitFor();
          await page.reload();
          await page.getByRole("button", { name: `Open Saved${label} Person` }).waitFor();

          // Empty states say what happened and how to recover.
          await page.fill("#contact-tag", "no-such-tag");
          await page.getByText("No matching contacts").waitFor();
          await page.fill("#contact-tag", "");

          // Search: a slow earlier response cannot overwrite a newer one.
          let slowed = false;
          await page.route("**/api/contacts?*", async (route) => {
            if (!slowed && route.request().url().includes("q=Nora")) {
              slowed = true;
              await new Promise((r) => setTimeout(r, 1500));
            }
            await route.continue();
          });
          await page.fill("#contact-search", "Nora");
          await page.waitForTimeout(400);
          await page.fill("#contact-search", "Nate");
          await page.getByRole("button", { name: "Open Nate North" }).waitFor();
          await page.waitForTimeout(1800);
          assert.equal(await page.getByRole("button", { name: "Open Nora North" }).count(), 0, "the late Nora response was ignored");
          assert.equal(await page.getByRole("button", { name: "Open Nate North" }).count(), 1);
          await page.unroute("**/api/contacts?*");
          await page.screenshot({ path: join(shots, "contacts-final.png"), fullPage: true });
          console.log(`packet 3 ${label} screenshots: ${shots}`);
        } catch (err) {
          await page.screenshot({ path: join(shots, "failure.png"), fullPage: true }).catch(() => undefined);
          console.error(`packet 3 ${label} failed (screenshots: ${shots})`);
          throw err;
        } finally {
          await browser.close().catch(() => undefined);
        }
      });
    }
  });

  describe("packet 4: failures and recovery", () => {
    const leaks = (text: string) => {
      const found: string[] = [];
      for (const [name, value] of [["anon key", env.anonKey], ["service key", env.serviceRoleKey], ["jwt secret", env.jwtSecret]] as const) {
        if (value && text.includes(value)) found.push(name);
      }
      if (/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\./.test(text)) found.push("a JWT");
      if (/sb-[a-z0-9-]+-auth-token=/.test(text)) found.push("a session cookie");
      if (/postgres(ql)?:\/\//i.test(text)) found.push("a database URL");
      if (/SQLSTATE|permission denied for|violates|relation "|PGRST\d|authenticator|at [A-Za-z]+ \(.*:\d+:\d+\)/.test(text)) found.push("database or stack detail");
      return found;
    };
    const contactCount = async (ws: string, first: string) =>
      Number((await db.query<{ n: number }>("select count(*)::int n from public.contacts where workspace_id = $1 and first_name = $2 and deleted_at is null", [ws, first])).rows[0].n);
    async function browserAs(who: Identity, ws?: string) {
      const browser = await launchBrowser();
      const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
      ctx.setDefaultTimeout(20_000);
      await ctx.addInitScript("window.__name = (f) => f");
      const page = await ctx.newPage();
      const base = app.url.replace("//127.0.0.1:", "//localhost:");
      await page.goto(`${base}/login`);
      await page.fill("#email", who.email);
      await page.fill("#password", who.password);
      await page.click("button[type=submit]");
      await page.waitForURL(/\/dashboard$/);
      if (ws) assert.equal(await page.evaluate(async () => (await (await fetch("/api/auth/me")).json()).workspace?.id), ws);
      return { browser, ctx, page, base };
    }
    async function openAddContact(page: import("playwright-core").Page, base: string, first: string) {
      await page.goto(`${base}/contacts`);
      await page.getByRole("button", { name: "Add a contact" }).click();
      const dialog = page.getByRole("dialog", { name: "Add a contact" });
      await dialog.locator("#c-first").fill(first);
      await dialog.locator("#c-last").fill("Recovery");
      return dialog;
    }

    test("browser: interrupted and repeated saves, expired session, suspension while a page is open", async () => {
      const shots = mkdtempSync(join(tmpdir(), "fna-fail-"));
      await switchTo(wsS);
      const { browser, ctx, page, base } = await browserAs(owner, wsS);
      try {
        // The connection drops after the server saved: the screen must not claim either outcome.
        let dialog = await openAddContact(page, base, "Interrupted");
        await page.route("**/api/contacts", async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          await route.fetch();
          await route.abort("connectionreset");
        });
        await dialog.getByRole("button", { name: "Add contact", exact: true }).click();
        const unknown = dialog.getByRole("alert");
        await unknown.waitFor();
        assert.match(await unknown.innerText(), /may or may not have been saved/i);
        assert.doesNotMatch(await unknown.innerText(), /was added|saved\.$/i);
        assert.equal(await contactCount(wsS, "Interrupted"), 1, "the server did save it");
        await page.unroute("**/api/contacts");
        await page.reload();
        await page.getByRole("button", { name: "Open Interrupted Recovery" }).waitFor();
        assert.equal(await page.getByRole("button", { name: "Open Interrupted Recovery" }).count(), 1, "reload shows it once");

        // Slow saves pressed repeatedly are sent once (contact and note).
        const slow = async (pattern: string) => page.route(pattern, async (route) => {
          if (route.request().method() === "POST") await new Promise((r) => setTimeout(r, 1500));
          await route.continue();
        });
        await slow("**/api/contacts");
        dialog = await openAddContact(page, base, "Doubleclick");
        const addBtn = dialog.getByRole("button", { name: "Add contact", exact: true });
        await addBtn.dblclick();
        await addBtn.click({ force: true }).catch(() => undefined);
        await dialog.waitFor({ state: "detached", timeout: 10_000 });
        await page.unroute("**/api/contacts");
        assert.equal(await contactCount(wsS, "Doubleclick"), 1, "one contact for a double-clicked save");

        await page.getByRole("button", { name: "Open Sam South" }).click();
        const detail = page.getByRole("dialog", { name: "Sam South" });
        await slow("**/api/contacts/*/notes");
        await detail.locator("#c-note").fill("Synthetic note sent once");
        const noteBtn = detail.getByRole("button", { name: "Save note" });
        await noteBtn.dblclick();
        await noteBtn.click({ force: true }).catch(() => undefined);
        await detail.getByText("Synthetic note sent once").waitFor({ timeout: 10_000 });
        await page.waitForTimeout(2000);
        await page.unroute("**/api/contacts/*/notes");
        const notes = await db.query("select 1 from public.contact_notes where body = 'Synthetic note sent once'");
        assert.equal(notes.rowCount, 1, "one note for a repeatedly pressed save");
        await page.keyboard.press("Escape");

        // The session ends while the form is open: a clear refusal, the input stays, and after signing
        // in again (another tab) the same form saves exactly once.
        dialog = await openAddContact(page, base, "Afterexpiry");
        await ctx.clearCookies();
        await dialog.getByRole("button", { name: "Add contact", exact: true }).click();
        const expired = dialog.getByRole("alert");
        await expired.waitFor();
        assert.match(await expired.innerText(), /session has ended/i);
        assert.match(await expired.innerText(), /nothing was saved/i);
        assert.equal(await dialog.locator("#c-first").inputValue(), "Afterexpiry");
        const relogin = await ctx.newPage();
        await relogin.goto(`${base}/login`);
        await relogin.fill("#email", owner.email);
        await relogin.fill("#password", owner.password);
        await relogin.click("button[type=submit]");
        await relogin.waitForURL(/\/dashboard$/);
        await relogin.close();
        await dialog.getByRole("button", { name: "Add contact", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        assert.equal(await contactCount(wsS, "Afterexpiry"), 1);

        // Suspension while the page is open: refused with the reason; reactivation restores access.
        dialog = await openAddContact(page, base, "Whilesuspended");
        try {
          const suspend = await rpc(env, platformAal2, "platform_suspend_workspace", { p_workspace_id: wsS, p_reason: "Synthetic suspension rehearsal" });
          assert.ok([200, 204].includes(suspend.status), suspend.text);
          await dialog.getByRole("button", { name: "Add contact", exact: true }).click();
          const suspended = dialog.getByRole("alert");
          await suspended.waitFor();
          assert.match(await suspended.innerText(), /suspended/i);
          assert.match(await suspended.innerText(), /nothing was saved/i);
          assert.equal(await contactCount(wsS, "Whilesuspended"), 0);
          await page.screenshot({ path: join(shots, "suspended-dialog.png") });
          await page.reload();
          await page.waitForLoadState("networkidle");
          assert.ok(await page.getByText(/suspended/i).first().isVisible(), "the reloaded page explains the suspension");
        } finally {
          const reactivate = await rpc(env, platformAal2, "platform_reactivate_workspace", { p_workspace_id: wsS, p_reason: "Synthetic suspension rehearsal over" });
          assert.ok([200, 204].includes(reactivate.status), reactivate.text);
        }
        await page.goto(`${base}/contacts`);
        await page.getByRole("button", { name: "Open Sam South" }).waitFor();
        console.log(`packet 4 screenshots: ${shots}`);
      } catch (err) {
        await page.screenshot({ path: join(shots, "failure.png"), fullPage: true }).catch(() => undefined);
        console.error(`packet 4 browser flow failed (screenshots: ${shots})`);
        throw err;
      } finally {
        await browser.close().catch(() => undefined);
      }
    });

    test("browser: an employee's permission and then membership are removed while their page is open", async () => {
      await switchTo(wsS);
      const invite = await ok(call("POST", "/api/team/invitations", { email: email("employee"), role: "employee" }), "invite employee");
      const token = String(invite.body.inviteUrl).split("/invite/")[1];
      const employee = await signUp(env, email("employee"), "Erin Employee (synthetic)");
      assert.equal((await rpc(env, employee.token, "accept_invitation", { p_token: token })).status, 200);
      const { browser, page, base } = await browserAs(employee, wsS);
      try {
        const dialog = await openAddContact(page, base, "Employeesave");
        await ok(call("PATCH", `/api/team/${employee.id}`, { overrides: { "contacts.write": false } }), "remove contacts.write");
        await dialog.getByRole("button", { name: "Add contact", exact: true }).click();
        const refused = dialog.getByRole("alert");
        await refused.waitFor();
        assert.match(await refused.innerText(), /permission/i);
        assert.match(await refused.innerText(), /nothing was saved/i);
        assert.equal(await dialog.locator("#c-first").inputValue(), "Employeesave", "input kept");
        assert.equal(await contactCount(wsS, "Employeesave"), 0);

        await ok(call("DELETE", `/api/team/${employee.id}`), "remove employee");
        await dialog.getByRole("button", { name: "Add contact", exact: true }).click();
        await page.waitForFunction(() => /no longer have access/i.test(document.querySelector('[role="dialog"] [role="alert"]')?.textContent ?? ""));
        assert.equal(await contactCount(wsS, "Employeesave"), 0);
        await page.reload();
        await page.waitForLoadState("networkidle");
        assert.equal(await page.getByRole("button", { name: "Open Sam South" }).count(), 0, "no South records after removal");
        assert.deepEqual(leaks(await page.content()), []);
      } finally {
        await browser.close().catch(() => undefined);
      }
    });

    test("slow database, PostgREST, Auth, and Storage outages: honest errors, nothing half-done, no sensitive detail", async () => {
      await switchTo(wsS);
      const seen: string[] = [];
      const record = <T extends { text: string }>(r: T) => (seen.push(r.text), r);

      // A held table lock makes the write wait past the statement timeout: 503, nothing stored.
      const locker = await adminDb(env);
      try {
        await locker.query("begin");
        await locker.query("lock table public.contacts in access exclusive mode");
        const started = Date.now();
        const slowWrite = record(await call("POST", "/api/contacts", { firstName: "Lockedout", lastName: "Recovery" }));
        assert.deepEqual([slowWrite.status, slowWrite.body?.code], [503, "unavailable"], slowWrite.text);
        console.log(`locked write answered after ${Date.now() - started} ms`);
      } finally {
        await locker.query("rollback").catch(() => undefined);
        await locker.end();
      }
      assert.equal(await contactCount(wsS, "Lockedout"), 0, "nothing half-written");
      await ok(call("POST", "/api/contacts", { firstName: "Lockedout", lastName: "Retry" }), "retry after the lock");

      // PostgREST down: APIs answer 503, pages do not pretend the user signed out.
      stackService(stack, "rest", "stop");
      try {
        const list = record(await call("GET", "/api/contacts"));
        assert.deepEqual([list.status, list.body?.code], [503, "unavailable"], list.text);
        const write = record(await call("POST", "/api/contacts", { firstName: "Restdown", lastName: "Recovery" }));
        assert.equal(write.status, 503, write.text);
        const pageRes = await fetch(`${app.url}/contacts`, { headers: { cookie: ownerCookie }, redirect: "manual" });
        const pageText = await pageRes.text();
        seen.push(pageText);
        assert.doesNotMatch(pageRes.headers.get("location") ?? "", /\/login/, "an outage is not reported as signed out");
      } finally {
        stackService(stack, "rest", "start");
      }
      await waitForService(env, "rest");
      await ok(call("GET", "/api/contacts?limit=1"), "PostgREST back");
      assert.equal(await contactCount(wsS, "Restdown"), 0);

      // Auth down: a valid session is not treated as signed out and its cookie is kept.
      stackService(stack, "auth", "stop");
      try {
        const res = await fetch(`${app.url}/api/contacts?limit=1`, { headers: { cookie: ownerCookie }, redirect: "manual" });
        const text = await res.text();
        seen.push(text);
        assert.notEqual(res.status, 401, `an Auth outage must not read as signed out: ${text.slice(0, 200)}`);
        assert.ok([200, 503].includes(res.status), `${res.status}: ${text.slice(0, 200)}`);
        const cleared = res.headers.getSetCookie().filter((c) => /sb-.*-auth-token/.test(c) && /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c));
        assert.deepEqual(cleared, [], "the session cookie is not cleared");
        const pageRes = await fetch(`${app.url}/contacts`, { headers: { cookie: ownerCookie }, redirect: "manual" });
        seen.push(await pageRes.text());
        assert.doesNotMatch(pageRes.headers.get("location") ?? "", /\/login/, "pages do not send a signed-in user to login");
        const login = record(await fetch(`${app.url}/api/auth/login`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: owner.email, password: owner.password }),
        }).then(async (r) => ({ status: r.status, text: await r.text() })));
        assert.equal(login.status, 503, `login during an Auth outage: ${login.text.slice(0, 200)}`);
        console.log(`auth outage: API ${res.status}, page ${pageRes.status} ${pageRes.headers.get("location") ?? ""}, login ${login.status}`);
      } finally {
        stackService(stack, "auth", "start");
      }
      await waitForService(env, "auth");
      await ok(call("GET", "/api/contacts?limit=1"), "Auth back");

      // Storage down: a platform logo change is never reported as done; it stays recoverable.
      const aal2 = await upgradeToAal2Session(env, await signUp(env, email("storage-admin"), "Storage Platform Admin"));
      await db.query("insert into public.platform_admins (user_id) select id from auth.users where email = $1", [email("storage-admin")]);
      const adminCookie = sessionCookie(readSessionCookie(ownerCookie).name, aal2);
      const grant = await rpc(env, aal2.access_token, "platform_grant_access", { p_workspace_id: wsS, p_mode: "write", p_reason: "Storage outage rehearsal", p_minutes: 15 });
      assert.equal(grant.status, 200, grant.text);
      stackService(stack, "storage", "stop");
      try {
        const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
        const put = record(await appFetch(app, "/api/platform/workspace-logo", { method: "PUT", cookie: adminCookie, body: png, contentType: "image/png" }));
        assert.notEqual(put.status, 200, put.text);
        assert.ok(["operation_in_progress", "storage_failed", "unavailable", "audit_pending"].includes(put.body?.code), put.text);
        assert.ok(put.body.requestId, "the change can be recovered by request id");
        console.log(`storage outage: logo PUT ${put.status} ${put.body.code}`);
        const audit = await db.query("select action from public.workspace_audit_log where grant_id = $1 and action like 'storage.%'", [grant.body.id]);
        assert.ok(audit.rowCount! >= 1, "the attempt is in the audit log");
      } finally {
        stackService(stack, "storage", "start");
        await waitForService(env, "storage");
      }

      for (const text of seen) assert.deepEqual(leaks(text), [], `no sensitive detail in: ${text.slice(0, 160)}`);
    });
  });
});
