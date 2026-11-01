/* Browser helpers for the native §7.4 APIs (AUTH_PROVIDER=supabase). Requests carry the session
 * cookie; the server takes the workspace from the session, never from the client. */

import { markWorkspaceStale, workspaceHeaders } from "./workspace-pin";

export type ApiBody = { ok?: boolean; error?: string; code?: string; fields?: Record<string, string> } & Record<string, unknown>;

const OUTCOME_UNKNOWN =
  "The connection was interrupted before the server answered, so this may or may not have been saved. Reload the page to check before trying again.";

/** Plain-language refusals; every one of these means the request changed nothing. */
function refusal(code: string | undefined, write: boolean): string | null {
  const notSaved = write ? " Nothing was saved." : "";
  if (code === "unauthenticated") return `Your session has ended.${notSaved} Sign in again (another tab keeps this page), then try again.`;
  if (code === "forbidden") return `You do not have permission to do this.${notSaved} Ask the account owner if you need it.`;
  if (code === "no_active_workspace") return `You no longer have access to this business.${notSaved} Reload the page to continue.`;
  if (code === "workspace_suspended") return `This business is suspended.${notSaved} Contact your account manager.`;
  return null;
}

export async function api(path: string, init?: RequestInit): Promise<{ status: number; body: ApiBody }> {
  const write = (init?.method ?? "GET").toUpperCase() !== "GET";
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      cache: "no-store",
      headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...workspaceHeaders() },
    });
  } catch {
    return { status: 0, body: { error: write ? OUTCOME_UNKNOWN : "Network error. Try again.", code: write ? "outcome_unknown" : "network" } };
  }
  const body = (await res.json().catch(() => ({}))) as ApiBody;
  if (res.status === 409 && body.code === "workspace_changed") markWorkspaceStale();
  if (write && ((res.status >= 500 && !body.code) || (res.ok && body.ok === undefined))) {
    return { status: res.status, body: { error: OUTCOME_UNKNOWN, code: "outcome_unknown" } };
  }
  const plain = refusal(body.code, write);
  return { status: res.status, body: plain ? { ...body, error: plain } : body };
}

export function failure(body: ApiBody, fallback: string): string {
  const field = body.fields ? Object.values(body.fields)[0] : "";
  return field || body.error || fallback;
}

/** `YYYY-MM-DD HH:MM` in UTC like the server-rendered pages (identical on server and client), or "—". */
export function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 16).replace("T", " ");
}

/** Value for an `<input type="datetime-local">` from an ISO timestamp (local time). */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** ISO timestamp (with offset) from an `<input type="datetime-local">` value, or null when empty/invalid. */
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * True when a `datetime-local` value names a clock time that does not exist in the browser's time
 * zone (skipped when clocks move forward). Browsers silently shift such a value by the gap.
 */
export function isSkippedLocalTime(value: string): boolean {
  const iso = fromLocalInput(value);
  return iso !== null && toLocalInput(iso) !== value.slice(0, 16);
}

export const SKIPPED_TIME_MESSAGE = "That time does not exist in your time zone (the clocks change then). Choose another time.";

/** Dollars text ("12.34") → whole cents, or null when it is not a non-negative amount with ≤ 2 decimals. */
export function toCents(text: string): number | null {
  const t = text.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}

export function dollars(cents: number): string {
  const whole = Math.floor(cents / 100);
  const frac = cents % 100;
  return `$${whole.toLocaleString("en-US")}${frac ? `.${String(frac).padStart(2, "0")}` : ""}`;
}

export type Member = { userId: string; name: string; email: string; role: string };

/** Active members for assignee pickers (team.read; every current role holds it). */
export async function loadMembers(): Promise<Member[]> {
  const { body } = await api("/api/team");
  return body.ok && Array.isArray(body.members) ? (body.members as Member[]) : [];
}
