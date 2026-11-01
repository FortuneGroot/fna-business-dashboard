"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export type WorkspaceChoice = { id: string; name: string };

/** Card shown to signed-in users who cannot use a workspace. Same layout as the login card. */
export function AccessNotice({
  title,
  message,
  choices = [],
}: {
  title: string;
  message: string;
  choices?: WorkspaceChoice[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function signOut() {
    setBusy(true);
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    router.replace("/login");
    router.refresh();
  }

  async function choose(id: string) {
    setBusy(true);
    setError("");
    const res = await fetch("/api/workspaces/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: id }),
    }).catch(() => null);
    if (res?.ok) {
      router.replace("/dashboard");
      router.refresh();
      return;
    }
    const data = res ? await res.json().catch(() => ({})) : {};
    setError(data.error || "That workspace is not available.");
    setBusy(false);
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="brand-lockup" style={{ justifyContent: "center" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="brand-logo" src="/fna-logo.jpg" alt="Fortune & Automations" width={42} height={42} />
        </div>
        <h1 className="serif" style={{ textAlign: "center", fontSize: "1.35rem" }}>
          {title}
        </h1>
        <p className="muted" style={{ textAlign: "center", marginTop: 0 }}>
          {message}
        </p>
        {error ? <div className="banner error">{error}</div> : null}
        {choices.map((c) => (
          <button
            key={c.id}
            className="btn"
            type="button"
            disabled={busy}
            onClick={() => choose(c.id)}
            style={{ width: "100%", marginTop: "0.75rem" }}
          >
            Open {c.name}
          </button>
        ))}
        <button
          className="btn secondary"
          type="button"
          disabled={busy}
          onClick={signOut}
          style={{ width: "100%", marginTop: "1rem" }}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
