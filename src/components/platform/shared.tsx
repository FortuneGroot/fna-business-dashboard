"use client";

import { useEffect, useState } from "react";
import { Badge, Modal } from "@/components/ui";

export type WorkspaceStatus = "active" | "suspended" | "archived";

export function StatusBadge({ status }: { status: WorkspaceStatus }) {
  const tone = status === "active" ? "ok" : status === "suspended" ? "danger" : "neutral";
  const label = status === "active" ? "Active" : status === "suspended" ? "Suspended" : "Archived";
  return <Badge tone={tone}>{label}</Badge>;
}

export function ModeBadge({ mode }: { mode: "read" | "write" }) {
  return <Badge tone={mode === "write" ? "warn" : "neutral"}>{mode === "write" ? "Read and write" : "Read-only"}</Badge>;
}

const ACTIONS: Record<string, string> = {
  "workspace.provisioned": "Workspace provisioned",
  "workspace.suspended": "Workspace suspended",
  "workspace.reactivated": "Workspace reactivated",
  "workspace.bootstrap_invitation_rotated": "Owner invitation replaced",
  "access.granted": "Support access granted",
  "access.revoked": "Support access ended",
  "storage.change_requested": "Logo change requested",
};

export function actionLabel(action: string): string {
  return ACTIONS[action] ?? action;
}

/** Minutes left before `iso`, or 0 once it has passed. */
export function minutesLeft(iso: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(iso) - now) / 60_000));
}

/** Whether a grant is live; before mount (now === null) the server's `active` flag decides. */
export function isLive(g: { active: boolean; expiresAt: string }, now: number | null): boolean {
  return g.active && (now === null || minutesLeft(g.expiresAt, now) > 0);
}

/** " (N min left)" once mounted (empty during server render, so hydration matches). */
export function leftText(iso: string, now: number | null): string {
  return now === null ? "" : ` (${minutesLeft(iso, now)} min left)`;
}

/** The current time after mount, refreshed every 30 s so expiry countdowns stay current. */
export function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** A modal that asks for a reason (at least 10 characters) before a sensitive action. */
export function ReasonModal({
  open,
  title,
  intro,
  submitLabel,
  initialReason = "",
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  intro: string;
  submitLabel: string;
  initialReason?: string;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<string | null>;
}) {
  const [reason, setReason] = useState(initialReason);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setReason(initialReason);
      setError("");
    }
  }, [open, initialReason]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (reason.trim().length < 10) {
      setError("Give a reason of at least 10 characters.");
      return;
    }
    setBusy(true);
    setError("");
    const failure = await onSubmit(reason.trim());
    setBusy(false);
    if (failure) setError(failure);
  }

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <form onSubmit={submit}>
        <p className="muted" style={{ marginTop: 0 }}>{intro}</p>
        {error ? <div className="banner error" role="alert">{error}</div> : null}
        <label htmlFor="platform-reason">Reason (recorded in the audit log)</label>
        <textarea id="platform-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} required />
        <div style={{ marginTop: "1rem", display: "flex", gap: "0.5rem" }}>
          <button className="btn" type="submit" disabled={busy}>{busy ? "Working…" : submitLabel}</button>
          <button className="btn secondary" type="button" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

/** Shows a newly issued invitation link once. It cannot be shown again after this dialog closes. */
export function InviteLinkModal({ url, title, onClose }: { url: string | null; title: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [url]);
  return (
    <Modal open={Boolean(url)} onClose={onClose} title={title}>
      <div className="banner" role="status">
        This link is shown only once. Send it to the owner yourself; nothing is emailed. If it is lost, replace the owner invitation.
      </div>
      <label htmlFor="platform-invite-link">Owner invitation link</label>
      <input id="platform-invite-link" readOnly value={url ?? ""} onFocus={(e) => e.currentTarget.select()} />
      <div style={{ marginTop: "1rem", display: "flex", gap: "0.5rem" }}>
        <button
          className="btn"
          type="button"
          onClick={async () => {
            if (url) await navigator.clipboard?.writeText(url).catch(() => undefined);
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy link"}
        </button>
        <button className="btn secondary" type="button" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}
