"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState } from "react";
import { Modal } from "./ui";

export type SupportAccessInfo = {
  grantId: string;
  workspaceName: string;
  workspaceStatus: string;
  mode: "read" | "write";
  expiresAt: string;
};

const SupportAccessContext = createContext<SupportAccessInfo | null>(null);

export function SupportAccessProvider({ value, children }: { value: SupportAccessInfo | null; children: React.ReactNode }) {
  return <SupportAccessContext.Provider value={value}>{children}</SupportAccessContext.Provider>;
}

const utc = (iso: string) => new Date(iso).toISOString().slice(0, 16).replace("T", " ");

/**
 * Shown on every workspace page while a platform admin is inside a workspace through a support grant:
 * which workspace, the grant mode, and when it expires, with a way to end it.
 */
export function SupportAccessBanner() {
  const info = useContext(SupportAccessContext);
  const router = useRouter();
  const [now, setNow] = useState<number | null>(null);
  const [ending, setEnding] = useState(false);
  const [reason, setReason] = useState("Support session finished");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  if (!info) return null;
  const left = now === null ? null : Math.max(0, Math.ceil((Date.parse(info.expiresAt) - now) / 60_000));

  async function end(e: React.FormEvent) {
    e.preventDefault();
    if (reason.trim().length < 10) {
      setError("Give a reason of at least 10 characters.");
      return;
    }
    setBusy(true);
    setError("");
    const res = await fetch(`/api/platform/access/${info!.grantId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: reason.trim() }),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok && res?.status !== 404) {
      const body = res ? await res.json().catch(() => ({})) : {};
      setError((body as { error?: string }).error || "Access could not be ended.");
      return;
    }
    router.replace("/platform");
    router.refresh();
  }

  return (
    <div className="banner" role="status" aria-label="Platform support access" style={{ marginBottom: "1rem" }}>
      <strong>Platform support access:</strong> {info.workspaceName}
      {info.workspaceStatus === "suspended" ? " (suspended)" : ""} · {info.mode === "write" ? "Read and write" : "Read-only"} · expires{" "}
      {utc(info.expiresAt)} UTC{left === null ? "" : ` (${left} min left)`}.
      <span style={{ display: "inline-flex", gap: "0.4rem", marginLeft: "0.6rem" }}>
        <Link className="btn ghost sm" href="/platform">Platform console</Link>
        <button className="btn secondary sm" type="button" onClick={() => setEnding(true)}>End access</button>
      </span>
      <Modal open={ending} onClose={() => setEnding(false)} title="End support access">
        <form onSubmit={end}>
          <p className="muted" style={{ marginTop: 0 }}>You leave {info.workspaceName} immediately.</p>
          {error ? <div className="banner error" role="alert">{error}</div> : null}
          <label htmlFor="support-end-reason">Reason (recorded in the audit log)</label>
          <textarea id="support-end-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} required />
          <div style={{ marginTop: "1rem" }}>
            <button className="btn" type="submit" disabled={busy}>{busy ? "Ending…" : "End access"}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
