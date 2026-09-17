/**
 * Safe internal redirect targets only.
 * Allows paths that start with exactly one `/` and are not protocol-relative.
 */
export function safeNextPath(raw: unknown, fallback = "/dashboard"): string {
  if (raw == null) return fallback;
  let value = String(raw).trim();
  if (!value) return fallback;

  // Decode repeatedly to catch double-encoding bypasses (cap iterations).
  for (let i = 0; i < 4; i++) {
    try {
      const decoded = decodeURIComponent(value);
      if (decoded === value) break;
      value = decoded;
    } catch {
      return fallback;
    }
  }

  value = value.trim();
  // Must be a single-root absolute path.
  if (!value.startsWith("/")) return fallback;
  if (value.startsWith("//")) return fallback;
  if (value.startsWith("/\\")) return fallback;
  if (value.includes("://")) return fallback;
  if (/^[\\/]{2,}/.test(value)) return fallback;
  if (/[\0\r\n]/.test(value)) return fallback;
  // Reject backslash tricks and encoded dots used for host confusion.
  if (value.includes("\\")) return fallback;
  if (/^\/[/\\]/.test(value)) return fallback;

  // Only allow relative app paths (no scheme-relative, no userinfo).
  if (value.includes("@")) return fallback;

  return value || fallback;
}
