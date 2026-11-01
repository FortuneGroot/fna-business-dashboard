// Scale rehearsal (hardening packet 6) on a fresh disposable stack: one synthetic business with more
// than 1,000 rows of every list type (including hundreds of rows sharing one timestamp, so page
// boundaries fall inside ties), and a small business as the comparison point. Every list is walked
// through the app with the owner's own session and compared to the exact database ordering; pages
// are timed and their database statements counted.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type pg from "pg";
import { adminDb, appFetch, appLogin, rpc, signUp, startApp, startStack, upgradeToAal2, type App, type Identity, type Stack } from "../supabase-stack/stack";

const run = Date.now().toString(36);
const email = (who: string) => `${who}-${run}@example.test`;
const N = { contacts: 1500, opportunities: 1250, tasks: 1100, conversations: 1050, messages: 1200, appointments: 1100, reviews: 1020, audit: 1100 };

let stack: Stack;
let db: pg.Client;
let app: App;
let owner: Identity;
let cookie = "";
let big = "";
let small = "";
let bigConversation = "";
const measurements: string[] = [];

const call = async (path: string, init: { method?: string; json?: unknown } = {}) => {
  const res = await fetch(`${app.url}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie, ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    redirect: "manual",
  });
  const text = await res.text();
  assert.equal(res.status, 200, `${path}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
};
const ids = async (sql: string, params: unknown[]) => (await db.query<{ id: string }>(sql, params)).rows.map((r) => String(r.id));

/** Follows nextCursor to the end; checks every page's size, the reported total, and no repeats. */
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
  const r = await db.query<{ n: string }>(
    `select coalesce(sum(calls), 0)::text n from extensions.pg_stat_statements
     where userid in ('authenticated'::regrole, 'authenticator'::regrole, 'anon'::regrole, 'service_role'::regrole)`);
  return Number(r.rows[0].n);
}

/** Median wall time over three loads and the database statements of one load (requests are serialized). */
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
  const r = await appFetch(app, path, { cookie });
  assert.equal(r.status, 200, `${path}: ${r.status}`);
  return r.text.replace(/<!-- -->/g, "");
};
const switchTo = (ws: string) => call("/api/workspaces/active", { method: "POST", json: { workspaceId: ws } });

async function seedBig(ws: string, ownerId: string) {
  const tie = "2030-06-01T00:00:00Z";
  await db.query("begin");
  try {
    await db.query(
      `insert into public.contacts (workspace_id, first_name, last_name, email, created_at, updated_at, deleted_at)
       select $1, (array['Ava','Ben','Cleo','Dev','Eli','Fay','Gus','Hal','Ivy','Jo'])[1 + i % 10],
              case when i % 12 = 0 then 'Garcia' else 'Surname' || i end, 'person' || i || '@example.test',
              case when i <= 400 then $2::timestamptz else '2029-01-01T00:00:00Z'::timestamptz + i * interval '1 second' + (i % 997) * interval '1 microsecond' end,
              now(), case when i % 35 = 0 then now() end
       from generate_series(1, $3::int) i`, [ws, tie, N.contacts]);
    await db.query(
      `insert into public.contact_tags (workspace_id, contact_id, tag)
       select workspace_id, id, 'vip' from (select workspace_id, id, row_number() over (order by email) rn from public.contacts where workspace_id = $1) c where rn % 5 = 0`, [ws]);
    await db.query(
      `with c as (select id, row_number() over (order by email) rn from public.contacts where workspace_id = $1 and deleted_at is null),
            s as (select ps.id, ps.pipeline_id, ps.kind, row_number() over (order by ps.position) rn, count(*) over () n
                  from public.pipeline_stages ps join public.pipelines p on p.id = ps.pipeline_id and p.is_default where ps.workspace_id = $1)
       insert into public.opportunities (workspace_id, contact_id, pipeline_id, stage_id, title, value_cents, status, created_at, updated_at)
       select $1, c.id, s.pipeline_id, s.id, 'Deal ' || i, i * 100 + 7, case s.kind when 'won' then 'won' when 'lost' then 'lost' else 'open' end,
              case when i <= 300 then $2::timestamptz else '2029-01-01T00:00:00Z'::timestamptz + i * interval '1 second' end, now()
       from generate_series(1, $3::int) i
       join c on c.rn = 1 + (i % 1400)
       join s on s.rn = case when i <= 1050 then 1 else 1 + (i % s.n) end`, [ws, tie, N.opportunities]);
    await db.query(
      `insert into public.tasks (workspace_id, title, status, assigned_user_id, created_at, updated_at)
       select $1, 'Synthetic task ' || i, case when i % 11 < 7 then 'open' else 'done' end, $4,
              case when i <= 300 then $2::timestamptz else '2029-01-01T00:00:00Z'::timestamptz + i * interval '1 second' end, now()
       from generate_series(1, $3::int) i`, [ws, tie, N.tasks, ownerId]);
    await db.query(
      `with c as (select id, row_number() over (order by email) rn from public.contacts where workspace_id = $1 and deleted_at is null)
       insert into public.conversations (workspace_id, contact_id, channel, status, created_at, last_message_at)
       select $1, c.id, 'sms', case when i % 4 = 0 then 'closed' else 'open' end,
              case when i <= 200 then $2::timestamptz else '2029-01-01T00:00:00Z'::timestamptz + i * interval '1 second' end, now()
       from generate_series(1, $3::int) i join c on c.rn = 1 + (i % 1400)`, [ws, tie, N.conversations]);
    bigConversation = (await db.query<{ id: string }>(
      "select id from public.conversations where workspace_id = $1 order by created_at desc, id desc limit 1", [ws])).rows[0].id;
    await db.query(
      `insert into public.messages (workspace_id, conversation_id, direction, body, delivery_status, created_at)
       select $1, $2, case when i % 2 = 0 then 'inbound' else 'outbound' end, 'Synthetic message ' || i, 'delivered',
              case when i <= 250 then $3::timestamptz else '2029-01-01T00:00:00Z'::timestamptz + i * interval '1 second' end
       from generate_series(1, $4::int) i`, [ws, bigConversation, tie, N.messages]);
    const calendar = (await db.query<{ id: string }>(
      "insert into public.calendars (workspace_id, name, slug, timezone, duration_minutes) values ($1, 'Busy chairs', 'busy-chairs', 'America/Chicago', 60) returning id", [ws])).rows[0].id;
    await db.query(
      `with c as (select id, row_number() over (order by email) rn from public.contacts where workspace_id = $1 and deleted_at is null)
       insert into public.appointments (workspace_id, calendar_id, contact_id, starts_at, ends_at, status)
       select $1, $2, c.id, '2031-01-01T00:00:00Z'::timestamptz + i * interval '7 hours', '2031-01-01T01:00:00Z'::timestamptz + i * interval '7 hours',
              case when i % 10 = 0 then 'cancelled' else 'booked' end
       from generate_series(1, $3::int) i join c on c.rn = 1 + (i % 1400)`, [ws, calendar, N.appointments]);
    await db.query(
      `insert into public.reviews (workspace_id, rating, source, body, received_at)
       select $1, 1 + i % 5, 'manual', 'Synthetic review ' || i,
              case when i <= 300 then $2::timestamptz else '2029-01-01T00:00:00Z'::timestamptz + i * interval '1 second' end
       from generate_series(1, $3::int) i`, [ws, tie, N.reviews]);
    await db.query("set local session_replication_role = replica");
    await db.query(
      `insert into public.workspace_audit_log (workspace_id, actor_id, actor_kind, action, target, metadata)
       select $1, $2, 'member', 'contact.updated', 'synthetic-' || i, '{}'::jsonb from generate_series(1, $3::int) i`, [ws, ownerId, N.audit]);
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
  await db.query("analyze");
}

describe("scale: more than 1,000 records per list in one synthetic business", () => {
  before(async () => {
    stack = startStack();
    db = await adminDb(stack.env);
    await db.query("create extension if not exists pg_stat_statements with schema extensions");
    app = await startApp(stack.env);
    const platform = await signUp(stack.env, email("platform"), "Scale Platform Admin");
    await db.query("insert into public.platform_admins (user_id) values ($1)", [platform.id]);
    const platformAal2 = await upgradeToAal2(stack.env, platform);
    owner = await signUp(stack.env, email("owner"), "Sasha Scale (synthetic)");
    for (const key of ["big", "small"]) {
      const prov = await rpc(stack.env, platformAal2, "platform_provision_workspace", {
        p_provisioning_key: `synthetic-${key}-${run}`, p_name: key === "big" ? "Busy Bees Cleaning (synthetic)" : "Tiny Tailors (synthetic)",
        p_slug: `${key}-${run}`, p_owner_email: owner.email,
      });
      assert.equal(prov.status, 200, prov.text);
      assert.equal((await rpc(stack.env, owner.token, "accept_invitation", { p_token: prov.body.invite_token })).status, 200);
      if (key === "big") big = prov.body.workspace_id;
      else small = prov.body.workspace_id;
    }
    cookie = await appLogin(app, owner);
    const t = performance.now();
    await seedBig(big, owner.id);
    measurements.push(`seeded ${Object.entries(N).map(([k, v]) => `${v} ${k}`).join(", ")} in ${Math.round(performance.now() - t)} ms`);
    await switchTo(small);
    for (const [first, last] of [["Gail", "Garcia"], ["Tom", "Tailor"], ["Tia", "Tuck"]]) {
      await call("/api/contacts", { method: "POST", json: { firstName: first, lastName: last, tags: ["vip"] } });
    }
    await call("/api/tasks", { method: "POST", json: { title: "Small task" } });
  });

  after(async () => {
    if (measurements.length) console.log(`\nscale measurements\n${measurements.join("\n")}\n`);
    app?.stop();
    await db?.end().catch(() => undefined);
    stack?.stop();
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
    const both = await ids(
      `select c.id from public.contacts c join public.contact_tags t on t.contact_id = c.id and t.workspace_id = c.workspace_id and t.tag = 'vip'
       where c.workspace_id = $1 and c.deleted_at is null and c.first_name = 'Ava' ${order.replace(/(created_at|id)/g, "c.$1")}`, [big]);
    await walk("/api/contacts?tag=vip&q=ava", 20, both, "tag vip + search ava");
    const html = await page("/contacts")();
    assert.ok(html.includes(`${live.length} contact(s) in this workspace`), "contacts page shows the exact total");
    measurements.push(`contacts: ${live.length} live (${pages} pages of 100), ${garcia.length} match "garcia", ${vip.length} tagged vip`);

    await switchTo(small);
    const smallGarcia = await call("/api/contacts?q=garcia&limit=100");
    assert.deepEqual(smallGarcia.items.map((c: { name: string }) => c.name), ["Gail Garcia"], "the busy business's rows never appear in the small one");
    assert.equal(smallGarcia.total, 1);
    await switchTo(big);
  });

  test("opportunities, tasks, conversations, messages, reviews, audit: exact totals, stable order, filters", async () => {
    await switchTo(big);
    const order = "order by created_at desc, id desc";
    const opps = await ids(`select id from public.opportunities where workspace_id = $1 and deleted_at is null ${order}`, [big]);
    await walk("/api/opportunities", 100, opps, "opportunities");
    const firstStage = (await db.query<{ id: string }>(
      `select ps.id from public.pipeline_stages ps join public.pipelines p on p.id = ps.pipeline_id and p.is_default where ps.workspace_id = $1 order by ps.position limit 1`, [big])).rows[0].id;
    await walk(`/api/opportunities?stageId=${firstStage}`, 100,
      await ids(`select id from public.opportunities where workspace_id = $1 and deleted_at is null and stage_id = $2 ${order}`, [big, firstStage]), "opportunities in the first stage");
    await walk("/api/opportunities?status=won", 100,
      await ids(`select id from public.opportunities where workspace_id = $1 and deleted_at is null and status = 'won' ${order}`, [big]), "won opportunities");

    const tasks = await ids(`select id from public.tasks where workspace_id = $1 and deleted_at is null ${order}`, [big]);
    await walk("/api/tasks", 100, tasks, "tasks");
    const open = await ids(`select id from public.tasks where workspace_id = $1 and deleted_at is null and status = 'open' ${order}`, [big]);
    await walk("/api/tasks?status=open", 100, open, "open tasks");

    await walk("/api/conversations", 100, await ids(`select id from public.conversations where workspace_id = $1 ${order}`, [big]), "conversations");
    await walk("/api/conversations?status=closed", 100,
      await ids(`select id from public.conversations where workspace_id = $1 and status = 'closed' ${order}`, [big]), "closed conversations");
    await walk(`/api/conversations/${bigConversation}/messages`, 100,
      await ids(`select id from public.messages where conversation_id = $1 ${order}`, [bigConversation]), "messages in one conversation");
    await walk("/api/reviews", 100, await ids("select id from public.reviews where workspace_id = $1 order by received_at desc, id desc", [big]), "reviews");
    await walk("/api/audit", 100, await ids("select id from public.workspace_audit_log where workspace_id = $1 order by id desc", [big]), "audit log");

    const summary = (await call("/api/dashboard/summary")).summary;
    const count = async (sql: string) => Number((await db.query<{ n: string }>(sql, [big])).rows[0].n);
    assert.equal(summary.contactsCount, await count("select count(*) n from public.contacts where workspace_id = $1 and deleted_at is null"));
    assert.equal(summary.opportunitiesCount, opps.length);
    assert.equal(summary.appointmentsCount, await count("select count(*) n from public.appointments where workspace_id = $1 and deleted_at is null"));
    const pipelineHtml = await page("/pipeline")();
    assert.ok(pipelineHtml.includes(`${opps.length} opportunities across`), "board count is exact beyond the 1,000-row cap");
    const tasksHtml = await page("/tasks")();
    assert.ok(tasksHtml.includes(`${tasks.length} task(s) · ${open.length} open`), "task counts are exact");
  });

  test("appointments: a busy calendar year is returned soonest first and honestly marked as truncated", async () => {
    await switchTo(big);
    const range = "from=2031-01-01T00:00:00Z&to=2032-01-01T00:00:00Z";
    const all = await ids(
      "select id from public.appointments where workspace_id = $1 and deleted_at is null and ends_at > '2031-01-01T00:00:00Z' and starts_at < '2032-01-01T00:00:00Z' order by starts_at, id", [big]);
    assert.ok(all.length > 1000);
    // 500 bookings name ~500 different contacts; their names are looked up in batches (one `in`
    // filter of 500 ids exceeds the gateway's URL limit and answered 503).
    const first = await call(`/api/appointments?${range}`);
    assert.equal(first.truncated, true, "the response says more bookings exist than it returned");
    assert.deepEqual(first.items.map((a: { id: string }) => a.id), all.slice(0, 500));
    const month = await call("/api/appointments?from=2031-03-01T00:00:00Z&to=2031-04-01T00:00:00Z");
    const march = await ids(
      "select id from public.appointments where workspace_id = $1 and deleted_at is null and ends_at > '2031-03-01T00:00:00Z' and starts_at < '2031-04-01T00:00:00Z' order by starts_at, id", [big]);
    assert.equal(month.truncated, false);
    assert.deepEqual(month.items.map((a: { id: string }) => a.id), march, "a month view is complete");
  });

  test("measured: page and API times and statement counts do not grow with the data", async () => {
    const pages = ["/dashboard", "/contacts", "/pipeline", "/calendar", "/tasks", "/inbox", "/reviews", "/reporting", "/settings"];
    const apis = ["/api/contacts?limit=50", "/api/contacts?q=garcia&limit=50", "/api/opportunities?limit=50", "/api/tasks?limit=50",
      "/api/conversations?limit=50", "/api/reviews?limit=50", "/api/audit?limit=50", "/api/dashboard/summary", "/api/appointments?from=2031-03-01T00:00:00Z&to=2031-04-01T00:00:00Z"];
    const results: { path: string; big: { ms: number; queries: number }; small: { ms: number; queries: number } }[] = [];
    for (const path of [...pages, ...apis]) {
      const load = path.startsWith("/api/") ? () => call(path) : page(path);
      await switchTo(small);
      const s = await measure(`small ${path}`, load);
      await switchTo(big);
      const b = await measure(`big   ${path}`, load);
      results.push({ path, big: b, small: s });
    }
    for (const r of results) {
      // Exact totals page through rows 1,000 at a time, so a few extra statements per 1,000 rows are expected.
      assert.ok(r.big.queries <= r.small.queries + 6, `${r.path}: ${r.big.queries} statements with large data vs ${r.small.queries} with small (N+1?)`);
      assert.ok(r.big.ms < 3000, `${r.path}: ${r.big.ms} ms with large data`);
    }
  });
});
