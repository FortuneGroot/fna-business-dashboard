import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { asAnon, asUser, buildWorld, rows, rpc, type TestUser, type World } from "./harness";

// P6 (migration 20261101001800): platform console reads and reason-bearing revocation. Every call
// runs as role authenticated with that user's JWT claims; the superuser only verifies outcomes.

let w: World;

before(async () => {
  w = await buildWorld();
});

after(async () => {
  await w.db.close();
});

type Page = { items: Array<{ id: string; name: string; slug: string; status: string; created_at: string; member_count: number; owner_joined: boolean }>; total: number };
const search = (u: TestUser, args: unknown[]) => asUser(w.db, u, (q) => rpc<Page>(q, "platform_search_workspaces", args));
const admin = <T>(sql: string, params: unknown[] = []) => rows<T>(w.db as never, sql, params);
const aal1 = () => ({ ...w.platform, aal: "aal1" as const });

describe("P6: platform_status", () => {
  test("reports only the caller's own listing, assurance level, and active authority", async () => {
    const status = (u: TestUser) => asUser(w.db, u, (q) => rpc<{ listed: boolean; aal: string; active: boolean }>(q, "platform_status"));
    assert.deepEqual(await status(w.ownerA), { listed: false, aal: "aal1", active: false });
    assert.deepEqual(await status(aal1()), { listed: true, aal: "aal1", active: false });
    assert.deepEqual(await status(w.platform), { listed: true, aal: "aal2", active: true });
    await assert.rejects(asAnon(w.db, (q) => rpc(q, "platform_status")), /permission denied/);
  });
});

describe("P6: console RPCs require an AAL2 platform admin", () => {
  test("members, owners, outsiders, AAL1 admins, and anonymous callers are refused", async () => {
    const calls: Array<[string, unknown[]]> = [
      ["platform_search_workspaces", [null, null, 25, null, null]],
      ["platform_get_workspace", [w.wsA]],
      ["platform_list_grants", [null, true, 50]],
      ["platform_audit_page", [null, null, 50]],
      ["platform_revoke_access", ["00000000-0000-0000-0000-000000000000", "Reason long enough"]],
    ];
    for (const user of [w.ownerA, w.employeeA, w.outsider, aal1()]) {
      for (const [fn, args] of calls) {
        await assert.rejects(asUser(w.db, user, (q) => rpc(q, fn, args)), /forbidden/, `${fn} as ${user.email}`);
      }
    }
    for (const [fn, args] of calls) {
      await assert.rejects(asAnon(w.db, (q) => rpc(q, fn, args)), /permission denied/, `${fn} as anon`);
    }
  });
});

describe("P6: platform_search_workspaces", () => {
  test("searches name, slug, and owner email literally, filters by status, and pages with an exact total", async () => {
    for (let i = 0; i < 5; i++) {
      await asUser(w.db, w.platform, (q) => rpc(q, "platform_provision_workspace", [
        `console-page-${i}`, `Console Page ${i} (synthetic)`, `console-page-${i}`, `owner-console-${i}@example.test`]));
    }
    const all = await search(w.platform, [null, null, 100, null, null]);
    assert.equal(all.total, 7);
    assert.equal(all.items.length, 7);
    const times = all.items.map((x) => Date.parse(x.created_at));
    assert.deepEqual(times, [...times].sort((a, b) => b - a), "newest first");

    const pages: string[][] = [];
    let cursor: [string | null, string | null] = [null, null];
    for (;;) {
      const page = await search(w.platform, ["console page", null, 2, ...cursor]);
      assert.equal(page.total, 5);
      pages.push(page.items.map((x) => x.slug));
      if (page.items.length < 2) break;
      const last = page.items[page.items.length - 1];
      cursor = [last.created_at, last.id];
    }
    assert.deepEqual(pages.map((p) => p.length), [2, 2, 1, 0].slice(0, pages.length));
    assert.equal(new Set(pages.flat()).size, 5, "no duplicates across pages");

    assert.deepEqual((await search(w.platform, ["tj-towing", null, 25, null, null])).items.map((x) => x.name), ["TJ Towing (synthetic)"]);
    assert.deepEqual((await search(w.platform, ["owner-console-3@", null, 25, null, null])).items.map((x) => x.slug), ["console-page-3"]);
    assert.equal((await search(w.platform, ["%", null, 25, null, null])).total, 0, "wildcards match literally");
    assert.equal((await search(w.platform, ["_", null, 25, null, null])).total, 0);

    const tj = (await search(w.platform, ["TJ Towing", null, 25, null, null])).items[0];
    assert.equal(tj.member_count, 4);
    assert.equal(tj.owner_joined, true);

    await asUser(w.db, w.platform, (q) => rpc(q, "platform_suspend_workspace", [w.wsB, "Console status filter check"]));
    assert.deepEqual((await search(w.platform, [null, "suspended", 25, null, null])).items.map((x) => x.id), [w.wsB]);
    assert.equal((await search(w.platform, [null, "active", 25, null, null])).total, 6);
    await asUser(w.db, w.platform, (q) => rpc(q, "platform_reactivate_workspace", [w.wsB, "Console status filter done"]));
  });

  test("malformed filters and cursors are refused", async () => {
    for (const args of [
      [null, "deleted", 25, null, null],
      [null, null, 0, null, null],
      [null, null, 102, null, null],
      ["x".repeat(101), null, 25, null, null],
      [null, null, 25, new Date().toISOString(), null],
      [null, null, 25, null, w.wsA],
    ]) {
      await assert.rejects(search(w.platform, args), /validation_failed/, JSON.stringify(args).slice(0, 80));
    }
  });
});

describe("P6: platform_get_workspace", () => {
  test("returns identity, status, membership counts, and the open owner invitation without any token", async () => {
    const prov = await asUser(w.db, w.platform, (q) => rpc<{ workspace_id: string; invite_token: string }>(q, "platform_provision_workspace", [
      "console-detail", "Console Detail (synthetic)", "console-detail", "owner-detail@example.test"]));
    const detail = await asUser(w.db, w.platform, (q) => rpc<Record<string, any>>(q, "platform_get_workspace", [prov.workspace_id]));
    assert.equal(detail.name, "Console Detail (synthetic)");
    assert.equal(detail.bootstrap_owner_email, "owner-detail@example.test");
    assert.deepEqual(detail.members, { owner: 0, admin: 0, employee: 0 });
    assert.equal(detail.can_rotate_bootstrap, true);
    assert.deepEqual(Object.keys(detail.open_owner_invitation).sort(), ["created_at", "expires_at", "id"]);
    const text = JSON.stringify(detail);
    assert.equal(text.includes(prov.invite_token), false, "the issued token is never returned");
    assert.doesNotMatch(text, /token|hash/i);

    const a = await asUser(w.db, w.platform, (q) => rpc<Record<string, any>>(q, "platform_get_workspace", [w.wsA]));
    assert.deepEqual(a.members, { owner: 1, admin: 1, employee: 2 });
    assert.equal(a.open_owner_invitation, null);
    assert.equal(a.can_rotate_bootstrap, false);

    await assert.rejects(asUser(w.db, w.platform, (q) => rpc(q, "platform_get_workspace", ["00000000-0000-0000-0000-000000000000"])), /not_found/);
  });
});

describe("P6: grants and revocation with a reason", () => {
  test("lists live grants with mode, expiry, and owner; revocation needs a reason and is audited with it", async () => {
    const grant = await asUser(w.db, w.platform, (q) => rpc<{ id: string }>(q, "platform_grant_access", [w.wsA, "read", "Console grant listing check", 30]));
    type G = { id: string; workspace_id: string; workspace_name: string; mode: string; reason: string; active: boolean; mine: boolean; admin_email: string; expires_at: string };
    const live = await asUser(w.db, w.platform, (q) => rpc<G[]>(q, "platform_list_grants", [null, true, 50]));
    const mine = live.find((g) => g.id === grant.id)!;
    assert.equal(mine.workspace_name, "TJ Towing (synthetic)");
    assert.equal(mine.mode, "read");
    assert.equal(mine.active, true);
    assert.equal(mine.mine, true);
    assert.equal(mine.admin_email, w.platform.email);
    assert.ok(Date.parse(mine.expires_at) > Date.now());
    assert.deepEqual((await asUser(w.db, w.platform, (q) => rpc<G[]>(q, "platform_list_grants", [w.wsB, true, 50]))), []);

    await assert.rejects(asUser(w.db, w.platform, (q) => rpc(q, "platform_revoke_access", [grant.id, "too short"])), /validation_failed/);
    await assert.rejects(asUser(w.db, w.platform, (q) => rpc(q, "platform_revoke_access", [grant.id, null])), /validation_failed/);
    await assert.rejects(asUser(w.db, w.platform, (q) => rpc(q, "platform_revoke_access", [grant.id])), /permission denied/,
      "the reason-less revoke is no longer callable");
    await asUser(w.db, w.platform, (q) => rpc(q, "platform_revoke_access", [grant.id, "Console check finished"]));
    await assert.rejects(asUser(w.db, w.platform, (q) => rpc(q, "platform_revoke_access", [grant.id, "Console check finished"])), /not_found/);

    assert.deepEqual((await asUser(w.db, w.platform, (q) => rpc<G[]>(q, "platform_list_grants", [w.wsA, true, 50]))), []);
    const history = await asUser(w.db, w.platform, (q) => rpc<G[]>(q, "platform_list_grants", [w.wsA, false, 50]));
    assert.equal(history.find((g) => g.id === grant.id)?.active, false);

    const [platformAudit] = await admin<{ actor_id: string; reason: string; metadata: Record<string, unknown> }>(
      "select actor_id, reason, metadata from public.platform_audit_log where action = 'access.revoked' and metadata ->> 'grant_id' = $1", [grant.id]);
    assert.deepEqual(platformAudit, { actor_id: w.platform.id, reason: "Console check finished", metadata: { grant_id: grant.id, mode: "read" } });
    const [wsAudit] = await admin<{ actor_kind: string; grant_id: string; metadata: Record<string, unknown> }>(
      "select actor_kind, grant_id, metadata from public.workspace_audit_log where action = 'platform.access_revoked' and grant_id = $1", [grant.id]);
    assert.deepEqual(wsAudit, { actor_kind: "platform_admin", grant_id: grant.id, metadata: { reason: "Console check finished" } });

    await assert.rejects(asUser(w.db, w.platform, (q) => rpc(q, "platform_list_grants", [null, true, 0])), /validation_failed/);
  });

  test("an expired grant cannot be ended: not_found, still unrevoked, nothing audited", async () => {
    const grant = await asUser(w.db, w.platform, (q) => rpc<{ id: string }>(q, "platform_grant_access", [w.wsA, "read", "Console expiry check", 5]));
    await admin("update public.platform_access_grants set created_at = now() - interval '10 minutes', expires_at = now() - interval '1 second' where id = $1", [grant.id]);
    await assert.rejects(asUser(w.db, w.platform, (q) => rpc(q, "platform_revoke_access", [grant.id, "Ending an expired grant"])), /not_found/);
    const [row] = await admin<{ revoked_at: string | null }>("select revoked_at from public.platform_access_grants where id = $1", [grant.id]);
    assert.equal(row.revoked_at, null);
    const audit = await admin("select 1 from public.platform_audit_log where action = 'access.revoked' and metadata ->> 'grant_id' = $1", [grant.id]);
    assert.equal(audit.length, 0);
  });
});

describe("P6: platform_audit_page", () => {
  test("pages newest first by id with actor email and workspace name; filters by workspace", async () => {
    type A = { id: number; action: string; actor_email: string | null; workspace_name: string | null; reason: string | null };
    const page = (args: unknown[]) => asUser(w.db, w.platform, (q) => rpc<A[]>(q, "platform_audit_page", args));
    const first = await page([null, null, 3]);
    assert.equal(first.length, 3);
    const second = await page([null, first[2].id, 3]);
    assert.ok(second.every((x) => x.id < first[2].id));
    const ids = [...first, ...second].map((x) => x.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a));
    const total = Number((await admin<{ n: string }>("select count(*) n from public.platform_audit_log"))[0].n);
    assert.equal((await page([null, null, 101])).length, Math.min(total, 101));

    const forA = await page([w.wsA, null, 101]);
    assert.ok(forA.length > 0 && forA.every((x) => x.workspace_name === "TJ Towing (synthetic)"));
    assert.ok(forA.some((x) => x.action === "workspace.provisioned" && x.actor_email === w.platform.email));
    assert.equal(JSON.stringify(forA).includes("token_hash"), false);

    await assert.rejects(page([null, null, 0]), /validation_failed/);
    await assert.rejects(page([null, null, 102]), /validation_failed/);
  });
});
