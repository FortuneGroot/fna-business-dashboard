import { BRAND } from "@/lib/brand";
import { loadEnv } from "@/lib/env";
import {
  PROTECTED_MASTER_LOCATION_ID,
  configuredLocationId,
} from "@/lib/tenant";
import {
  createSupabaseRestClient,
  isSupabaseConfigured,
  type SyncDb,
} from "./db-client";
import { createMemoryStore } from "./memory-store";
import { createPostgresStore } from "./postgres-store";
import type { StorageMode, SyncStore } from "./store";

const GLOBAL_KEY = "__fna_sync_store__";
const GLOBAL_MODE = "__fna_sync_storage_mode__";

type GlobalStore = typeof globalThis & {
  [GLOBAL_KEY]?: SyncStore;
  [GLOBAL_MODE]?: StorageMode;
};

export function resolveStorageMode(
  env: NodeJS.ProcessEnv = process.env
): StorageMode {
  return isSupabaseConfigured(env) ? "postgres" : "memory";
}

export function isDatabaseConfigured(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return isSupabaseConfigured(env);
}

export function createSyncStore(opts?: {
  env?: NodeJS.ProcessEnv;
  db?: SyncDb;
  forceMode?: StorageMode;
}): SyncStore {
  const env = opts?.env || process.env;
  const mode = opts?.forceMode || resolveStorageMode(env);
  if (mode === "postgres") {
    const db = opts?.db || createSupabaseRestClient(env);
    let locationId = (env.GHL_LOCATION_ID || "").trim();
    if (!locationId) {
      try {
        locationId = configuredLocationId();
      } catch {
        locationId = BRAND.liveLocationId;
      }
    }
    if (locationId === PROTECTED_MASTER_LOCATION_ID || locationId === BRAND.forbiddenMasterId) {
      throw new Error("Protected Master location refused");
    }
    return createPostgresStore(db, locationId);
  }
  return createMemoryStore();
}

export function getSyncStore(): SyncStore {
  const g = globalThis as GlobalStore;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = createSyncStore();
    g[GLOBAL_MODE] = g[GLOBAL_KEY].storageMode;
  }
  return g[GLOBAL_KEY]!;
}

export function getStorageMode(): StorageMode {
  const g = globalThis as GlobalStore;
  if (g[GLOBAL_MODE]) return g[GLOBAL_MODE];
  return getSyncStore().storageMode;
}

export function resetSyncStoreForTests(store?: SyncStore): SyncStore {
  const g = globalThis as GlobalStore;
  g[GLOBAL_KEY] = store ?? createMemoryStore();
  g[GLOBAL_MODE] = g[GLOBAL_KEY].storageMode;
  return g[GLOBAL_KEY]!;
}

/** Re-evaluate env and rebuild singleton (e.g. after test env changes). */
export function rebindSyncStoreFromEnv(env: NodeJS.ProcessEnv = process.env): SyncStore {
  const g = globalThis as GlobalStore;
  g[GLOBAL_KEY] = createSyncStore({ env });
  g[GLOBAL_MODE] = g[GLOBAL_KEY].storageMode;
  return g[GLOBAL_KEY]!;
}

export function assertDeploymentLocationSafe(): void {
  const env = loadEnv();
  if (
    env.locationId === PROTECTED_MASTER_LOCATION_ID ||
    env.locationId === env.forbiddenMasterId ||
    env.locationId === BRAND.forbiddenMasterId
  ) {
    throw new Error("Protected Master location refused");
  }
  const configured = configuredLocationId();
  if (env.locationId !== configured) {
    throw new Error("Location not allowed for this dashboard");
  }
}
