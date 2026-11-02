// Hosted large-data check on the staging project (not part of any suite). Same synthetic busy
// business as tests/acceptance/scale.test.ts (>1,000 rows of every list, a busy calendar, a
// pipeline beyond the 1,000-row cap), walked through the local app with the owner's own session and
// compared to the exact database ordering. Pages are timed and their database statements counted.
// The app runs on this machine while the database is in the staging region, so absolute times
// include that network distance; statement counts are the growth measure.
//
//   STAGING_REHEARSAL=1 STAGING_PROJECT_REF=... STAGING_APP_URL=http://localhost:3000 (+ staging keys)
//   node --require ./scripts/stub-server-only.cjs --import tsx --test --test-concurrency=1 tests/staging/scale.test.ts
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { appFetch, appLogin } from "../supabase-stack/stack";
import { N, seedBig } from "../acceptance/scale-seed";
import { connectStaging, createAccount, provision, revokeAdmin, syntheticAdmin, type Staging } from "./env";

const run = Date.now().toString(36);
const email = (who: string) => `${who}-${run}@example.test`;

let s: Staging;
let adminId = "";
let cookie = "";
let big = "";
let small = "";
let bigConversation = "";
const measurements: string[] = [];

const call = async (path: string, init: { method?: string; json?: unknown } = {}) => {
  const res = await fetch(`${s.app.url}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie, ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    redirect: "manual",
  });
  const text = await res.text();
  assert.equal(res.status, 200, `${path}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
};
const ids = async (sql: string, params: unknown[]) => (await s.db.query<{ id: string }>(sql, params)).rows.map((r) => String(r.id));

async function walk(path: string, limit: number, expected: string[], label: string) {
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const sep: string = path.includes("?") ? "&" : "?";
    const body: any = await call(`${path}${sep}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (typeof body.total === "number") assert.equal(body.total, expected.length, `${label}: exact total on page ${pages + 1}`);
    if (body.nextCursor) assert.equal(body.items.length, limit, `${label}: full page before the last`);
    seen.push(...body.items.map((i: { id: string | number }) => String(i.id)));
    cursor = body.nextCursor;
    pages += 1;
    assert.ok(pages <= Math.ceil(expected.length / limit) + 1, `${label}: paging terminates`);
  } while (cursor);
  assert.equal(new Set(seen).size, seen.length, `${label}: no row repeated across pages`);
  assert.deepEqual(seen, expected, `${label}: every row exactly once, in stable (time desc, id desc) order`);
  return pages;
}

async function statements(): Promise<number> {
  const r = await s.db.query<{ n: string }>(
    `select coalesce(sum(calls), 0)::text n from extensions.pg_stat_statements
     where userid in ('authenticated'::regrole, 'authenticator'::regrole, 'anon'::regrole, 'service_role'::regrole)
       and query not ilike '%check_request_session%'`);
  return Number(r.rows[0].n);
}

async function measure(label: string, load: () => Promise<unknown>) {
  await load();
  const times: number[] = [];
  let queries = 0;
  for (let i = 0; i < 3; i++) {
    const before = await statements();
    const t = performance.now();
    await load();
    times.push(performance.now() - t);
    if (i === 0) queries = (await statements()) - before;
  }
  const ms = Math.round(times.sort((a, b) => a - b)[1]);
  measurements.push(`${label.padEnd(44)} ${String(ms).padStart(6)} ms  ${String(queries).padStart(4)} statements`);
  return { ms, queries };
}

const page = (path: string) => async () => {
  const r = await appFetch(s.app, path, { cookie });
  assert.equal(r.status, 200, `${path}: ${r.status}`);
  return r.text.replace(/<!-- -->/g, "");
};
const switchTo = (ws: string) => call("/api/workspaces/active", { method: "POST", json: { workspaceId: ws } });

describe("staging scale: more than 1,000 records per list in one synthetic business", () => {
  before(async () => {
    s = await connectStaging();
    const admin = await syntheticAdmin(s, email("scale-platform"), `Stg-scale-admin-${run}-Aa1!`, "tests/staging/scale.test.ts");
    adminId = admin.id;
    const owner = await createAccount(s.env, email("scale-owner"), `Stg-scale-owner-${run}-Aa1!`, "Sasha Scale (synthetic)");
    big = await provision(s, admin.aal2, owner, `synthetic-big-${run}`, "Busy Bees Cleaning (synthetic)");
    small = await provision(s, admin.aal2, owner, `synthetic-small-${run}`, "Tiny Tailors (synthetic)");
    cookie = await appLogin(s.app, { ...owner, token: "" });
    const t = performance.now();
    bigConversation = await seedBig(s.db, big, owner.id);
    measurements.push(`seeded ${Object.entries(N).map(([k, v]) => `${v} ${k}`).join(", ")} in ${Math.round(performance.now() - t)} ms`);
    await switchTo(small);
    for (const [first, last] of [["Gail", "Garcia"], ["Tom", "Tailor"], ["Tia", "Tuck"]]) {
      await call("/api/contacts", { method: "POST", json: { firstName: first, lastName: last, tags: ["vip"] } });
    }
    await call("/api/tasks", { method: "POST", json: { title: "Small task" } });
  });

  after(async () => {
    if (measurements.length) console.log(`\nstaging scale measurements\n${measurements.join("\n")}\n`);
    if (s) {
      await revokeAdmin(s, adminId, "staging scale check finished");
      await s.db.end().catch(() => undefined);
    }
  });

  test("contacts: exact totals, page boundaries inside 400 identical timestamps, search and tag filters", async () => {
    await switchTo(big);
    const order = "order by created_at desc, id desc";
    const live = await ids(`select id from public.contacts where workspace_id = $1 and deleted_at is null ${order}`, [big]);
    assert.ok(live.length > 1000);
    const pages = await walk("/api/contacts", 100, live, "contacts by 100");
    await walk("/api/contacts", 37, live, "contacts by 37");
    const garcia = await ids(
      `select id from public.contacts where workspace_id = $1 and deleted_at is null and (first_name ilike '%garcia%' or last_name ilike '%garcia%' or email::text ilike '%garcia%' or phone ilike '%garcia%') ${order}`, [big]);
    await walk("/api/contacts?q=garcia", 50, garcia, "search garcia");
    const vip = await ids(
      `select c.id from public.contacts c join public.contact_tags t on t.contact_id = c.id and t.workspace_id = c.workspace_id and t.tag = 'vip'
       where c.workspace_id = $1 and c.deleted_at is null ${order.replace(/(created_at|id)/g, "c.$1")}`, [big]);
    await walk("/api/contacts?tag=vip", 100, vip, "tag vip");
    const html = await page("/contacts")();
    assert.ok(html.includes(`${live.length} contact(s) in this workspace`), "contacts page shows the exact total");
    measurements.push(`contacts: ${live.length} live (${pages} pages of 100), ${garcia.length} match "garcia", ${vip.length} tagged vip`);

    await switchTo(small);
    const smallGarcia = await call("/api/contacts?q=garcia&limit=100");
    assert.deepEqual(smallGarcia.items.map((c: { name: string }) => c.name), ["Gail Garcia"], "the busy business's rows never appear in the small one");
    assert.equal(smallGarcia.total, 1);
  });

  test("pipeline: paginated opportunities, stage and status filters, exact board count beyond 1,000, older stage offered", async () => {
    await switchTo(big);
    const order = "order by created_at desc, id desc";
    const opps = await ids(`select id from public.opportunities where workspace_id = $1 and deleted_at is null ${order}`, [big]);
    await walk("/api/opportunities", 100, opps, "opportunities");
    const firstStage = (await s.db.query<{ id: string }>(
      `select ps.id from public.pipeline_stages ps join public.pipelines p on p.id = ps.pipeline_id and p.is_default where ps.workspace_id = $1 order by ps.position limit 1`, [big])).rows[0].id;
    await walk(`/api/opportunities?stageId=${firstStage}`, 100,
      await ids(`select id from public.opportunities where workspace_id = $1 and deleted_at is null and stage_id = $2 ${order}`, [big, firstStage]), "opportunities in the first stage");
    await walk("/api/opportunities?status=won", 100,
      await ids(`select id from public.opportunities where workspace_id = $1 and deleted_at is null and status = 'won' ${order}`, [big]), "won opportunities");
    const pipelineHtml = await page("/pipeline")();
    assert.ok(pipelineHtml.includes(`${opps.length} opportunities across`), "board count is exact beyond the 1,000-row cap");
    const lastStage = (await s.db.query<{ id: string; n: number }>(
      `select ps.id, (select count(*)::int from public.opportunities o where o.stage_id = ps.id and o.deleted_at is null) n
       from public.pipeline_stages ps join public.pipelines p on p.id = ps.pipeline_id and p.is_default
       where ps.workspace_id = $1 order by ps.position desc limit 1`, [big])).rows[0];
    assert.ok(lastStage.n > 0, "the last stage has deals");
    await s.db.query("begin");
    await s.db.query("set local session_replication_role = replica");
    await s.db.query("update public.opportunities set updated_at = '2001-01-01T00:00:00Z' where stage_id = $1", [lastStage.id]);
    await s.db.query("commit");
    const olderHtml = await page("/pipeline")();
    assert.ok(olderHtml.includes(`Show ${lastStage.n} more`), `the stage offers its ${lastStage.n} older deals`);
    measurements.push(`pipeline: ${opps.length} opportunities, last stage ${lastStage.n} older deals offered`);
  });

  test("tasks, conversations, messages, reviews, audit: exact totals and stable order; summary counts", async () => {
    await switchTo(big);
    const order = "order by created_at desc, id desc";
    const tasks = await ids(`select id from public.tasks where workspace_id = $1 and deleted_at is null ${order}`, [big]);
    await walk("/api/tasks", 100, tasks, "tasks");
    await walk("/api/conversations", 100, await ids(`select id from public.conversations where workspace_id = $1 ${order}`, [big]), "conversations");
    await walk(`/api/conversations/${bigConversation}/messages`, 100,
      await ids(`select id from public.messages where conversation_id = $1 ${order}`, [bigConversation]), "messages in one conversation");
    await walk("/api/reviews", 100, await ids("select id from public.reviews where workspace_id = $1 order by received_at desc, id desc", [big]), "reviews");
    await walk("/api/audit", 100, await ids("select id from public.workspace_audit_log where workspace_id = $1 order by id desc", [big]), "audit log");
    const summary = (await call("/api/dashboard/summary")).summary;
    const count = async (sql: string) => Number((await s.db.query<{ n: string }>(sql, [big])).rows[0].n);
    assert.equal(summary.contactsCount, await count("select count(*) n from public.contacts where workspace_id = $1 and deleted_at is null"));
    assert.equal(summary.opportunitiesCount, await count("select count(*) n from public.opportunities where workspace_id = $1 and deleted_at is null"));
    assert.equal(summary.appointmentsCount, await count("select count(*) n from public.appointments where workspace_id = $1 and deleted_at is null"));
  });

  test("busy calendar: a year is returned soonest first and marked truncated; a month is complete; the page renders", async () => {
    await switchTo(big);
    const all = await ids(
      "select id from public.appointments where workspace_id = $1 and deleted_at is null and ends_at > '2031-01-01T00:00:00Z' and starts_at < '2032-01-01T00:00:00Z' order by starts_at, id", [big]);
    assert.ok(all.length > 1000);
    const first = await call("/api/appointments?from=2031-01-01T00:00:00Z&to=2032-01-01T00:00:00Z");
    assert.equal(first.truncated, true, "the response says more bookings exist than it returned");
    assert.deepEqual(first.items.map((a: { id: string }) => a.id), all.slice(0, 500));
    const month = await call("/api/appointments?from=2031-03-01T00:00:00Z&to=2031-04-01T00:00:00Z");
    const march = await ids(
      "select id from public.appointments where workspace_id = $1 and deleted_at is null and ends_at > '2031-03-01T00:00:00Z' and starts_at < '2031-04-01T00:00:00Z' order by starts_at, id", [big]);
    assert.equal(month.truncated, false);
    assert.deepEqual(month.items.map((a: { id: string }) => a.id), march, "a month view is complete");
    assert.ok((await page("/calendar")()).includes("Busy chairs"), "the calendar page lists the busy calendar");
    measurements.push(`calendar: ${all.length} bookings in 2031 (500 returned, truncated), March ${march.length} complete`);
  });

  test("measured: statement counts do not grow with the data; times recorded", async () => {
    const paths = ["/dashboard", "/contacts", "/pipeline", "/calendar", "/tasks", "/inbox", "/reviews", "/reporting",
      "/api/contacts?limit=50", "/api/contacts?q=garcia&limit=50", "/api/opportunities?limit=50", "/api/tasks?limit=50",
      "/api/dashboard/summary", "/api/appointments?from=2031-03-01T00:00:00Z&to=2031-04-01T00:00:00Z"];
    const results: { path: string; big: { ms: number; queries: number }; small: { ms: number; queries: number } }[] = [];
    for (const path of paths) {
      const load = path.startsWith("/api/") ? () => call(path) : page(path);
      await switchTo(small);
      const sm = await measure(`small ${path}`, load);
      await switchTo(big);
      const b = await measure(`big   ${path}`, load);
      results.push({ path, big: b, small: sm });
    }
    for (const r of results) {
      assert.ok(r.big.queries <= r.small.queries + 6, `${r.path}: ${r.big.queries} statements with large data vs ${r.small.queries} with small (N+1?)`);
      assert.ok(r.big.ms < Math.max(3000, 2 * r.small.ms), `${r.path}: ${r.big.ms} ms with large data vs ${r.small.ms} ms small`);
    }
  });
});
