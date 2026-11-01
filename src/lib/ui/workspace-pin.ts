/* The active workspace is per user, shared by every tab. Each loaded document pins the workspace it
 * was rendered for and sends it as a precondition header (`X-FNA-Workspace`); the server refuses a
 * mismatch with 409 `workspace_changed`, so a tab left on another business can neither show nor
 * change the newly active one. The pin never selects a workspace, and it changes only with a full
 * page load (`switchWorkspace`). */

let pinned: string | null = null;
let stale = false;
export const WORKSPACE_CHANGED_EVENT = "fna:workspace-changed";
export const WORKSPACE_SWITCH_KEY = "fna:workspace-switch";

export function pinWorkspace(id: string | null | undefined): void {
  if (typeof window === "undefined" || !id) return;
  if (pinned === null) pinned = id;
  else if (pinned !== id) markWorkspaceStale();
}

export function pinnedWorkspace(): string | null {
  return pinned;
}

export function isWorkspaceStale(): boolean {
  return stale;
}

export function markWorkspaceStale(): void {
  if (stale || typeof window === "undefined") return;
  stale = true;
  window.dispatchEvent(new Event(WORKSPACE_CHANGED_EVENT));
}

export function workspaceHeaders(): Record<string, string> {
  return pinned ? { "X-FNA-Workspace": pinned } : {};
}

type SwitchResult = { status: number; body: { error?: string; fields?: Record<string, string> } & Record<string, unknown> };

/** Switches the active workspace, tells other tabs, and reloads so nothing from the previous one survives. */
export async function switchWorkspace(id: string, next = "/dashboard"): Promise<SwitchResult> {
  let result: SwitchResult;
  try {
    const res = await fetch("/api/workspaces/active", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: id }),
    });
    result = { status: res.status, body: await res.json().catch(() => ({})) };
  } catch {
    return { status: 0, body: { error: "Network error. Try again." } };
  }
  if (result.status === 200) {
    try {
      window.localStorage.setItem(WORKSPACE_SWITCH_KEY, `${id}:${Date.now()}`);
    } catch {
      // storage unavailable: other tabs still learn of it from their next request
    }
    window.location.assign(next);
  }
  return result;
}
