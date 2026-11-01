"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";

type Preview = { workspaceName: string; role: string; emailMasked: string; accountExists: boolean };
type Me = { email: string } | null;

const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", employee: "Team member" };

/** Invitation landing page (§7.4). Same card layout as the login page; nothing is sent from here. */
export default function InvitePage() {
  const router = useRouter();
  const { token } = useParams<{ token: string }>();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [me, setMe] = useState<Me>(null);
  const [state, setState] = useState<"loading" | "ready" | "invalid">("loading");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const load = useCallback(async () => {
    setState("loading");
    const [inviteRes, meRes] = await Promise.all([
      fetch(`/api/invitations/${encodeURIComponent(token)}`, { cache: "no-store" }).catch(() => null),
      fetch("/api/auth/me", { cache: "no-store" }).catch(() => null),
    ]);
    const meBody = meRes?.ok ? await meRes.json().catch(() => ({})) : {};
    setMe(meBody?.user?.email ? { email: meBody.user.email } : null);
    const body = inviteRes ? await inviteRes.json().catch(() => ({})) : {};
    if (inviteRes?.ok && body.ok) {
      setPreview(body as Preview);
      setState("ready");
    } else {
      setNotice(body.error || "This invitation link is not valid.");
      setState("invalid");
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function accept(withPassword?: string) {
    setBusy(true);
    setError("");
    const res = await fetch(`/api/invitations/${encodeURIComponent(token)}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(withPassword ? { password: withPassword } : {}),
    }).catch(() => null);
    const body = res ? await res.json().catch(() => ({})) : {};
    if (res?.ok && body.ok) {
      router.replace("/dashboard");
      router.refresh();
      return;
    }
    setError(body.fields?.password || body.error || "Could not accept the invitation. Try again.");
    setBusy(false);
  }

  function onCreate(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("The passwords do not match.");
      return;
    }
    void accept(password);
  }

  async function signOut() {
    setBusy(true);
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    await load();
    setBusy(false);
  }

  const loginHref = `/login?next=${encodeURIComponent(`/invite/${token}`)}`;

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="brand-lockup" style={{ justifyContent: "center" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="brand-logo" src="/fna-logo.jpg" alt="Fortune & Automations" width={42} height={42} />
        </div>

        {state === "loading" ? (
          <p className="muted" style={{ textAlign: "center" }}>Checking your invitation…</p>
        ) : null}

        {state === "invalid" ? (
          <>
            <h1 className="serif" style={{ textAlign: "center", fontSize: "1.35rem" }}>Invitation unavailable</h1>
            <div className="banner error" role="alert">{notice}</div>
            <Link className="btn secondary" href="/login" style={{ width: "100%", marginTop: "1rem" }}>Go to sign in</Link>
          </>
        ) : null}

        {state === "ready" && preview ? (
          <>
            <h1 className="serif" style={{ textAlign: "center", fontSize: "1.35rem" }}>
              Join {preview.workspaceName}
            </h1>
            <p className="muted" style={{ textAlign: "center", marginTop: 0 }}>
              You were invited as <strong style={{ color: "var(--primary)" }}>{ROLE_LABEL[preview.role] ?? preview.role}</strong>{" "}
              using {preview.emailMasked}.
            </p>
            {error ? <div className="banner error" role="alert">{error}</div> : null}

            {me ? (
              <>
                <p className="muted" style={{ textAlign: "center" }}>Signed in as {me.email}</p>
                <button className="btn" type="button" disabled={busy} onClick={() => void accept()} style={{ width: "100%", marginTop: "0.5rem" }}>
                  {busy ? "Joining…" : "Accept invitation"}
                </button>
                <button className="btn secondary" type="button" disabled={busy} onClick={() => void signOut()} style={{ width: "100%", marginTop: "0.75rem" }}>
                  Use a different account
                </button>
              </>
            ) : preview.accountExists ? (
              <>
                <p className="muted" style={{ textAlign: "center" }}>
                  An account already exists for this email. Sign in to accept.
                </p>
                <Link className="btn" href={loginHref} style={{ width: "100%", marginTop: "0.5rem" }}>Sign in to accept</Link>
              </>
            ) : (
              <form onSubmit={onCreate}>
                <label htmlFor="invite-password">Choose a password</label>
                <input
                  id="invite-password"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={72}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <label htmlFor="invite-confirm">Confirm password</label>
                <input
                  id="invite-confirm"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={72}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                />
                <button className="btn" type="submit" disabled={busy} style={{ width: "100%", marginTop: "1rem" }}>
                  {busy ? "Creating account…" : "Create account and join"}
                </button>
                <p className="muted" style={{ marginTop: "1rem", fontSize: "0.85rem" }}>
                  At least 12 characters. You will sign in with the invited email address.
                </p>
              </form>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
