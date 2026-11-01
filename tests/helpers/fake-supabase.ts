import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// A minimal local stand-in for GoTrue, PostgREST RPC, and Storage on 127.0.0.1, for deterministic
// route tests (token expiry and refresh, injected RPC failures, Storage writes held in flight or losing
// their response, and the database's attribution of tagged writes). Keys are placeholders, not secrets.

export type FakeUser = { id: string; email: string; name: string };
export type FakeSession = {
  access_token: string;
  refresh_token: string;
  token_type: "bearer";
  expires_in: number;
  expires_at: number;
  user: Record<string, unknown>;
};
type Reply = { status: number; body: unknown };
type RpcHandler = (args: Record<string, unknown>, caller: { userId: string | null; service: boolean }) => Reply;
type StorageRequest = {
  id: number; actorId: string; operation: string; path: string;
  token?: string; claimedAt?: number; applied?: boolean; outcome?: "succeeded" | "failed";
};
type StoredObject = { version: number; token: string | null; writtenBy: "service" | "user" };
const LEASE_MS = 120_000;

const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

export async function startFakeSupabase() {
  const anonKey = "fake-anon-key-not-a-secret";
  const serviceKey = "fake-service-role-key-not-a-secret";
  const accessTokens = new Map<string, string>();
  const refreshTokens = new Map<string, string>();
  const users = new Map<string, FakeUser>();
  const contexts = new Map<string, Record<string, unknown>>();
  const calls: { method: string; path: string; bearer: string | null; body: unknown }[] = [];
  const objects = new Map<string, StoredObject>();
  const requests = new Map<number, StorageRequest>();
  let seq = 0;
  let version = 0;
  const faults = {
    finishFailures: 0,
    requestedFails: false,
    uploadFails: false,
    /** While set, service-role Storage writes wait for it before committing (an in-flight write). */
    holdWrites: null as Promise<void> | null,
    /** Drop the connection instead of answering a service-role Storage write, before or after committing. */
    dropWriteResponse: null as "before_commit" | "after_commit" | null,
    /** Record the claim, then drop the connection instead of answering. */
    dropClaimResponse: false,
  };
  const storageArrivals: string[] = [];

  /**
   * The database trigger. The Storage API commits every write the same way, so attribution goes by
   * the operation token alone: a newly written token is attributed to its claimed request, and refused
   * once that request is finished; a token carried over unchanged is not a new write.
   */
  function recordWrite(token: string | null, kind: "upsert" | "move", path: string, from?: string, previous?: string | null): Reply | null {
    if (!token || (kind === "upsert" && token === previous)) return null;
    const r = [...requests.values()].find((o) => o.token === token);
    if (!r) return null;
    if (r.outcome) return { status: 403, body: { statusCode: "403", error: "Unauthorized", message: "platform_operation_closed" } };
    const ok = kind === "upsert"
      ? r.operation === "upsert" && path === r.path
      : r.operation === "delete" && from === r.path && path === tombstone(r);
    if (!ok) return { status: 403, body: { statusCode: "403", error: "Unauthorized", message: "platform_operation_mismatch" } };
    r.applied = true;
    return null;
  }
  const tombstone = (r: StorageRequest) =>
    `${r.path.split("/")[0]}/.platform-trash/${r.id}-${r.token}.${r.path.split(".").pop()}`;

  const userJson = (u: FakeUser) => ({
    id: u.id, aud: "authenticated", role: "authenticated", email: u.email,
    app_metadata: { provider: "email" }, user_metadata: { full_name: u.name }, created_at: "2026-01-01T00:00:00Z",
  });

  function issue(user: FakeUser, opts: { expired?: boolean } = {}): FakeSession {
    users.set(user.id, user);
    const now = Math.floor(Date.now() / 1000);
    const exp = opts.expired ? now - 600 : now + 3600;
    const access = [
      b64({ alg: "HS256", typ: "JWT" }),
      b64({ sub: user.id, email: user.email, role: "authenticated", aud: "authenticated", aal: "aal2",
        iat: now - 60, exp, session_id: `s-${++seq}`, user_metadata: { full_name: user.name } }),
      b64(`fake-signature-${seq}`),
    ].join(".");
    const refresh = `fake-refresh-${++seq}`;
    if (!opts.expired) accessTokens.set(access, user.id);
    refreshTokens.set(refresh, user.id);
    return { access_token: access, refresh_token: refresh, token_type: "bearer", expires_in: exp - now, expires_at: exp,
      user: userJson(user) };
  }

  const rpc: Record<string, RpcHandler> = {
    request_context: (_a, c) => c.userId
      ? { status: 200, body: contexts.get(c.userId) ?? { authenticated: true, user_id: c.userId, is_platform_admin: false,
          workspace: null, role: null, grant: null, permissions: [] } }
      : { status: 401, body: { code: "42501", message: "permission denied" } },
    list_my_workspaces: (_a, c) => c.userId ? { status: 200, body: [] } : { status: 401, body: { message: "permission denied" } },
    switch_workspace: () => ({ status: 403, body: { code: "42501", message: "forbidden" } }),
    platform_storage_change_requested: (a, c) => {
      if (faults.requestedFails) return { status: 500, body: { code: "XX000", message: "injected failure" } };
      const ctx = c.userId ? contexts.get(c.userId) : undefined;
      if (!ctx?.is_platform_admin || (ctx.grant as { mode?: string } | null)?.mode !== "write") {
        return { status: 403, body: { code: "42501", message: "forbidden" } };
      }
      const id = 1000 + requests.size;
      const path = String(a.p_object_path);
      requests.set(id, { id, actorId: c.userId!, operation: String(a.p_operation), path });
      return { status: 200, body: id };
    },
    platform_storage_change_claimed: (a, c) => {
      if (!c.service) return { status: 403, body: { code: "42501", message: "permission denied for function platform_storage_change_claimed" } };
      const r = requests.get(Number(a.p_request_id));
      if (!r || r.actorId !== a.p_actor_id) return { status: 404, body: { code: "P0002", message: "not_found" } };
      if (r.token || [...requests.values()].some((o) => o.token && !o.outcome && o.path === r.path)) {
        return { status: 409, body: { code: "23505", message: "conflict" } };
      }
      r.token = crypto.randomUUID();
      r.claimedAt = Date.now();
      return { status: 200, body: r.token };
    },
    platform_storage_change_finished: (a, c) => {
      if (!c.service) return { status: 403, body: { code: "42501", message: "permission denied for function platform_storage_change_finished" } };
      if (faults.finishFailures > 0) {
        faults.finishFailures--;
        return { status: 503, body: { code: "57P01", message: "injected failure" } };
      }
      const r = requests.get(Number(a.p_request_id));
      if (!r || r.actorId !== a.p_actor_id || !r.token) return { status: 404, body: { code: "P0002", message: "not_found" } };
      if (typeof a.p_operation_returned !== "boolean") return { status: 400, body: { code: "22023", message: "validation_failed" } };
      if (!r.outcome) {
        if (!a.p_operation_returned && !r.applied && Date.now() - r.claimedAt! < LEASE_MS) return { status: 200, body: "pending" };
        r.outcome = r.applied ? "succeeded" : "failed";
      }
      return { status: 200, body: r.outcome };
    },
  };

  async function readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }

  function send(res: ServerResponse, r: Reply) {
    if (r.status === 204) {
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(JSON.stringify(r.body));
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "") || null;
    const raw = await readBody(req);
    let body: unknown = null;
    try { body = raw.length ? JSON.parse(raw.toString("utf8")) : null; } catch { body = null; }
    calls.push({ method: req.method ?? "GET", path: url.pathname + url.search, bearer, body });
    const service = bearer === serviceKey;
    const userId = bearer && !service ? accessTokens.get(bearer) ?? null : null;

    if (url.pathname === "/auth/v1/user" && req.method === "GET") {
      const u = userId ? users.get(userId) : undefined;
      return send(res, u ? { status: 200, body: userJson(u) } : { status: 403, body: { code: "bad_jwt", msg: "invalid JWT" } });
    }
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
      const token = (body as { refresh_token?: string } | null)?.refresh_token ?? "";
      const owner = refreshTokens.get(token);
      if (!owner) return send(res, { status: 400, body: { code: "refresh_token_not_found", msg: "Invalid Refresh Token" } });
      refreshTokens.delete(token);
      return send(res, { status: 200, body: issue(users.get(owner)!) });
    }
    const rpcName = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/)?.[1];
    if (rpcName && req.method === "POST") {
      const handler = rpc[rpcName];
      if (!handler) return send(res, { status: 404, body: { code: "PGRST202", message: "function not found" } });
      const reply = handler((body ?? {}) as Record<string, unknown>, { userId, service });
      if (rpcName === "platform_storage_change_claimed" && faults.dropClaimResponse) return void res.destroy();
      return send(res, reply);
    }
    // Service-role writes may be held in flight or lose their response; members (any user bearer)
    // write directly, as the members-only Storage policies allow.
    const write = async (commit: () => Reply): Promise<void> => {
      if (service) storageArrivals.push(url.pathname);
      if (service && faults.holdWrites) await faults.holdWrites;
      if (service && faults.dropWriteResponse === "before_commit") return void res.destroy();
      const reply = commit();
      if (service && faults.dropWriteResponse === "after_commit") return void res.destroy();
      send(res, reply);
    };
    const objectPath = url.pathname.match(/^\/storage\/v1\/object\/workspace-assets\/(.+)$/)?.[1];
    if (objectPath && (req.method === "POST" || req.method === "PUT")) {
      if (!service && !userId) return send(res, { status: 403, body: { statusCode: "403", error: "Unauthorized", message: "denied" } });
      const header = req.headers["x-metadata"];
      let token: string | null = null;
      try { token = header ? JSON.parse(Buffer.from(String(header), "base64").toString("utf8")).platform_operation ?? null : null; } catch { token = null; }
      return write(() => {
        if (service && faults.uploadFails) return { status: 500, body: { statusCode: "500", error: "internal", message: "injected" } };
        const path = decodeURIComponent(objectPath);
        const refused = recordWrite(token, "upsert", path, undefined, objects.get(path)?.token);
        if (refused) return refused;
        objects.set(path, { version: ++version, token, writtenBy: service ? "service" : "user" });
        return { status: 200, body: { Key: `workspace-assets/${objectPath}`, Id: `obj-${version}` } };
      });
    }
    if (url.pathname === "/storage/v1/object/move" && req.method === "POST") {
      if (!service && !userId) return send(res, { status: 403, body: { message: "denied" } });
      const m = (body ?? {}) as { bucketId?: string; sourceKey?: string; destinationKey?: string };
      return write(() => {
        const src = objects.get(m.sourceKey ?? "");
        if (m.bucketId !== "workspace-assets" || !src) return { status: 400, body: { statusCode: "404", error: "not_found", message: "Object not found" } };
        const token = m.destinationKey?.match(/\/\.platform-trash\/\d+-([0-9a-f-]{36})\.[a-z]+$/)?.[1] ?? null;
        const refused = recordWrite(token, "move", m.destinationKey!, m.sourceKey);
        if (refused) return refused;
        objects.delete(m.sourceKey!);
        objects.set(m.destinationKey!, src);
        return { status: 200, body: { message: "Successfully moved" } };
      });
    }
    if (url.pathname === "/storage/v1/object/workspace-assets" && req.method === "DELETE") {
      if (!service && !userId) return send(res, { status: 403, body: { message: "denied" } });
      const removed = ((body as { prefixes?: string[] } | null)?.prefixes ?? []).filter((p) => objects.delete(p));
      return send(res, { status: 200, body: removed.map((name) => ({ name, bucket_id: "workspace-assets" })) });
    }
    send(res, { status: 404, body: { message: `fake: no route for ${req.method} ${url.pathname}` } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url, anonKey, serviceKey, calls, objects, requests, faults, contexts, issue, storageArrivals,
    /** Moves request `id`'s claim back past its lease, as if the clock had advanced. */
    expireLease: (id: number) => {
      const r = requests.get(id);
      if (r?.claimedAt) r.claimedAt -= LEASE_MS + 1;
    },
    /** A member's own Storage write (the members-only policies allow it), outside the platform endpoint. */
    memberUpload: (session: FakeSession, path: string, metadata?: Record<string, unknown>) =>
      fetch(`${url}/storage/v1/object/workspace-assets/${path}`, {
        method: "POST",
        headers: {
          apikey: anonKey, Authorization: `Bearer ${session.access_token}`, "content-type": "image/png", "x-upsert": "true",
          ...(metadata ? { "x-metadata": Buffer.from(JSON.stringify(metadata)).toString("base64") } : {}),
        },
        body: new Uint8Array([7, 7, 7]),
      }),
    memberRemove: (session: FakeSession, path: string) =>
      fetch(`${url}/storage/v1/object/workspace-assets`, {
        method: "DELETE",
        headers: { apikey: anonKey, Authorization: `Bearer ${session.access_token}`, "content-type": "application/json" },
        body: JSON.stringify({ prefixes: [path] }),
      }),
    /** @supabase/ssr cookie for `session` (single chunk; these sessions are small). */
    cookie: (session: FakeSession) => `sb-127-auth-token=base64-${b64(session)}`,
    rpcCalls: (name: string) => calls.filter((c) => c.path === `/rest/v1/rpc/${name}`),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type FakeSupabase = Awaited<ReturnType<typeof startFakeSupabase>>;
