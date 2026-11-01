"use client";

import { useEffect, useState } from "react";
import { api, failure } from "@/lib/ui/native-api";
import {
  WORKSPACE_CHANGED_EVENT,
  WORKSPACE_SWITCH_KEY,
  isWorkspaceStale,
  markWorkspaceStale,
  pinWorkspace,
  pinnedWorkspace,
  switchWorkspace,
} from "@/lib/ui/workspace-pin";

/** Pins the workspace this document was rendered for (rendered by the protected layout). */
export function WorkspacePin({ workspaceId }: { workspaceId: string | null }) {
  pinWorkspace(workspaceId);
  return null;
}

type Choice = { id: string; name: string; status: string; grantMode: string | null };

/** Top-bar business picker, shown only to users with more than one workspace. */
export function WorkspaceSwitcher() {
  const [choices, setChoices] = useState<Choice[]>([]);
  const [current, setCurrent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const pinned = pinnedWorkspace();
    if (!pinned) return;
    setCurrent(pinned);
    void api("/api/workspaces").then(({ body }) => {
      if (body.ok && Array.isArray(body.workspaces)) setChoices(body.workspaces as Choice[]);
    });
  }, []);

  if (choices.length < 2) return null;

  async function choose(id: string) {
    if (!id || id === current) return;
    setBusy(true);
    setError("");
    const { status, body } = await switchWorkspace(id);
    if (status !== 200) {
      setError(failure(body, "That business is not available."));
      setBusy(false);
    }
  }

  return (
    <div className="topbar-workspace">
      <label className="sr-only" htmlFor="topbar-workspace-select">
        Business
      </label>
      <select
        id="topbar-workspace-select"
        value={current}
        disabled={busy}
        aria-busy={busy}
        aria-describedby={error ? "topbar-workspace-error" : undefined}
        onChange={(e) => void choose(e.target.value)}
      >
        {choices.map((c) => (
          <option key={c.id} value={c.id} disabled={c.status === "suspended"}>
            {c.name}
            {c.grantMode ? " (support access)" : c.status === "suspended" ? " (suspended)" : ""}
          </option>
        ))}
      </select>
      {error ? (
        <span id="topbar-workspace-error" className="topbar-workspace-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Shown when this tab's business is no longer the active one: another tab switched, a request was
 * refused with `workspace_changed`, or the tab returned to view after a switch elsewhere.
 */
export function WorkspaceChangedBanner() {
  const [stale, setStale] = useState(isWorkspaceStale);

  useEffect(() => {
    const onChanged = () => setStale(true);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== WORKSPACE_SWITCH_KEY || !e.newValue) return;
      const pinned = pinnedWorkspace();
      if (pinned && e.newValue.split(":")[0] !== pinned) markWorkspaceStale();
    };
    const recheck = () => {
      const pinned = pinnedWorkspace();
      if (!pinned || document.visibilityState !== "visible") return;
      void api("/api/auth/me").then(({ status, body }) => {
        const active = (body.workspace as { id?: string } | null | undefined)?.id;
        if (status === 200 && active && active !== pinned) markWorkspaceStale();
      });
    };
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) recheck();
    };
    window.addEventListener(WORKSPACE_CHANGED_EVENT, onChanged);
    window.addEventListener("storage", onStorage);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", recheck);
    if (isWorkspaceStale()) setStale(true);
    return () => {
      window.removeEventListener(WORKSPACE_CHANGED_EVENT, onChanged);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, []);

  if (!stale) return null;
  return (
    <div className="banner error" role="alert" style={{ marginBottom: "1rem" }}>
      You switched to a different business in another tab. This tab still shows the previous one, and
      changes made here will not be saved.
      <div style={{ marginTop: "0.6rem" }}>
        <button type="button" className="btn secondary sm" onClick={() => window.location.reload()}>
          Reload this page
        </button>
      </div>
    </div>
  );
}
