import { createHash, timingSafeEqual } from "node:crypto";

/** Constant-time password compare — never log either side. */
export function passwordsMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

type Bucket = { count: number; resetAt: number };

const GLOBAL_RL = "__fna_auth_rate_limit__";
type GlobalRl = typeof globalThis & { [GLOBAL_RL]?: Map<string, Bucket> };

function buckets(): Map<string, Bucket> {
  const g = globalThis as GlobalRl;
  if (!g[GLOBAL_RL]) g[GLOBAL_RL] = new Map();
  return g[GLOBAL_RL]!;
}

/** Simple in-process brute-force guard. Returns true if allowed. */
export function consumeLoginAttempt(
  key: string,
  opts: { limit?: number; windowMs?: number } = {}
): { allowed: boolean; retryAfterSec: number } {
  const limit = opts.limit ?? 8;
  const windowMs = opts.windowMs ?? 60_000;
  const map = buckets();
  const now = Date.now();
  const cur = map.get(key);
  if (!cur || cur.resetAt <= now) {
    map.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSec: 0 };
  }
  cur.count += 1;
  map.set(key, cur);
  if (cur.count > limit) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((cur.resetAt - now) / 1000)),
    };
  }
  return { allowed: true, retryAfterSec: 0 };
}

export function resetLoginRateLimitForTests(): void {
  buckets().clear();
}
