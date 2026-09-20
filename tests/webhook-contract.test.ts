/**
 * Webhook contract + cross-tenant isolation — local fixtures only.
 * Never posts to Production.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it, beforeEach } from "node:test";
import {
  createMemoryStore,
  ingestSyncPayload,
  normalizeEventName,
  resetSyncStoreForTests,
  verifyWebhookSecret,
} from "../src/lib/sync";
import {
  FA_LIVE_LOCATION_ID,
  PROTECTED_MASTER_LOCATION_ID,
  faLiveDefaultClientConfig,
  resetTenantConfigForTests,
} from "../src/lib/tenant";
import { loadClientConfigFromFile } from "../src/lib/onboarding";

const FIXTURE_DIR = join(process.cwd(), "tests", "fixtures", "webhooks");
const SYNTH_LOC = "loc_synth_ready_001";
const SYNTH_PIPE = "pipe_synth_ready_001";

async function ingest(payload: Record<string, unknown>, store = createMemoryStore()) {
  return ingestSyncPayload(JSON.stringify(payload), payload, { store });
}

beforeEach(() => {
  process.env.GHL_DRY_RUN = "true";
  process.env.ALLOW_PRODUCTION_CONTACT_WRITES = "false";
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  resetSyncStoreForTests(createMemoryStore());
});

describe("webhook fixtures cover required event families", () => {
  it("loads every fixture JSON and normalizes to a known event", () => {
    const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"));
    assert.ok(files.length >= 7, "expected fixture families");
    for (const file of files) {
      const payload = JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8"));
      const normalized = normalizeEventName(payload.event || payload.type);
      assert.ok(normalized, `unknown event in ${file}`);
      assert.equal(payload.locationId, SYNTH_LOC);
    }
  });
});

describe("webhook secret gate", () => {
  it("rejects missing signature when enforced", () => {
    const r = verifyWebhookSecret({
      signatureHeader: "",
      dryRun: true,
      secretConfigured: false,
      secretValue: "",
      enforceFlag: true,
    });
    assert.deepEqual(r, { ok: false, code: "secret_required" });
  });

  it("rejects wrong signature", () => {
    const r = verifyWebhookSecret({
      signatureHeader: "wrong",
      dryRun: false,
      secretConfigured: true,
      secretValue: "correct-secret",
      enforceFlag: true,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "invalid_signature");
  });

  it("accepts matching secret", () => {
    const r = verifyWebhookSecret({
      signatureHeader: "correct-secret",
      dryRun: false,
      secretConfigured: true,
      secretValue: "correct-secret",
      enforceFlag: true,
    });
    assert.deepEqual(r, { ok: true });
  });
});

describe("ingest contract negative paths", () => {
  beforeEach(() => {
    process.env.GHL_LOCATION_ID = SYNTH_LOC;
    process.env.GHL_PIPELINE_ID = SYNTH_PIPE;
    const cfg = loadClientConfigFromFile(resolve("config/examples/synthetic-ready-client.json"));
    resetTenantConfigForTests(cfg);
  });

  it("rejects malformed payload missing location", async () => {
    const r = await ingest({ event: "lead.created", contactId: "c1" });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "malformed");
      assert.equal(r.status, 400);
    }
  });

  it("rejects unknown event", async () => {
    const r = await ingest({
      event: "not.a.real.event",
      locationId: SYNTH_LOC,
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "unknown_event");
      assert.equal(r.status, 400);
    }
  });

  it("rejects protected Master location", async () => {
    const r = await ingest({
      event: "lead.created",
      locationId: PROTECTED_MASTER_LOCATION_ID,
      contactId: "c_master",
      idempotencyKey: "master-1",
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "master_refused");
      assert.equal(r.status, 409);
    }
  });

  it("rejects wrong tenant location", async () => {
    const r = await ingest({
      event: "lead.created",
      locationId: FA_LIVE_LOCATION_ID,
      contactId: "c_wrong",
      idempotencyKey: "wrong-loc-1",
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "wrong_location");
      assert.equal(r.status, 403);
    }
  });

  it("accepts fixture lead and dedupes duplicate delivery", async () => {
    const store = createMemoryStore();
    resetSyncStoreForTests(store);
    const payload = JSON.parse(
      readFileSync(join(FIXTURE_DIR, "lead.created.json"), "utf8")
    ) as Record<string, unknown>;
    const first = await ingest(payload, store);
    assert.equal(first.ok, true);
    if (first.ok) assert.equal(first.processed, true);
    const second = await ingest(payload, store);
    assert.equal(second.ok, true);
    if (second.ok) {
      assert.equal(second.duplicate, true);
      assert.equal(second.processed, false);
    }
  });

  it("accepts each fixture family against synthetic tenant", async () => {
    const store = createMemoryStore();
    resetSyncStoreForTests(store);
    for (const file of readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"))) {
      const payload = JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")) as Record<
        string,
        unknown
      >;
      // Unique idempotency per run to avoid cross-file collisions when keys collide
      payload.idempotencyKey = `${String(payload.idempotencyKey || file)}-${Date.now()}-${file}`;
      const r = await ingest(payload, store);
      assert.equal(r.ok, true, `${file} should accept: ${JSON.stringify(r)}`);
    }
  });
});

describe("cross-tenant isolation (deployment-per-client)", () => {
  it("synthetic tenant store never accepts F&A live location events", async () => {
    process.env.GHL_LOCATION_ID = SYNTH_LOC;
    process.env.GHL_PIPELINE_ID = SYNTH_PIPE;
    resetTenantConfigForTests(
      loadClientConfigFromFile(resolve("config/examples/synthetic-ready-client.json"))
    );
    const store = createMemoryStore();
    resetSyncStoreForTests(store);

    const blocked = await ingest(
      {
        event: "lead.created",
        locationId: FA_LIVE_LOCATION_ID,
        contactId: "c_fa_live_leak",
        idempotencyKey: "cross-tenant-1",
      },
      store
    );
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.code, "wrong_location");

    const contacts = await store.listContacts();
    assert.equal(contacts.length, 0);
  });

  it("F&A live deployment rejects synthetic location events", async () => {
    process.env.GHL_LOCATION_ID = FA_LIVE_LOCATION_ID;
    process.env.GHL_PIPELINE_ID = faLiveDefaultClientConfig().ghl.pipelineId;
    resetTenantConfigForTests(faLiveDefaultClientConfig());
    const store = createMemoryStore();
    resetSyncStoreForTests(store);

    const blocked = await ingest(
      {
        event: "lead.created",
        locationId: SYNTH_LOC,
        contactId: "c_synth_into_fa",
        idempotencyKey: "cross-tenant-2",
      },
      store
    );
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.code, "wrong_location");
    assert.equal((await store.listContacts()).length, 0);
  });
});
