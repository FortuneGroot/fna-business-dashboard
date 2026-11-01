"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, failure } from "@/lib/ui/native-api";

type Enrollment = { factorId: string; qrCode: string; secret: string };

/**
 * Authenticator (TOTP) step for platform administration, in the login card layout. With a verified
 * authenticator it asks for the current code; otherwise it enrolls one first (QR code and setup key
 * shown once, to this user only). A correct code upgrades the session to AAL2.
 */
export function MfaSetup({ factorId: existingFactor }: { factorId: string | null }) {
  const router = useRouter();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const factorId = existingFactor ?? enrollment?.factorId ?? null;

  async function enroll() {
    setBusy(true);
    setError("");
    const { status, body } = await api("/api/auth/mfa/enroll", { method: "POST", body: "{}" });
    setBusy(false);
    if (status !== 200) {
      setError(failure(body, "The authenticator could not be set up."));
      return;
    }
    setEnrollment({ factorId: String(body.factorId), qrCode: String(body.qrCode), secret: String(body.secret) });
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    if (!factorId) return;
    setBusy(true);
    setError("");
    const { status, body } = await api("/api/auth/mfa/verify", { method: "POST", body: JSON.stringify({ factorId, code }) });
    setBusy(false);
    if (status !== 200) {
      setError(failure(body, "That code is not valid."));
      setCode("");
      return;
    }
    router.replace("/platform");
    router.refresh();
  }

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="brand-lockup" style={{ justifyContent: "center" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="brand-logo" src="/fna-logo.jpg" alt="Fortune & Automations" width={42} height={42} />
        </div>
        <h1 className="serif" style={{ textAlign: "center", fontSize: "1.35rem" }}>Verify it’s you</h1>
        <p className="muted" style={{ textAlign: "center", marginTop: 0 }}>
          Platform administration requires your authenticator app.
        </p>
        {error ? <div className="banner error" role="alert">{error}</div> : null}

        {!factorId ? (
          <button className="btn" type="button" disabled={busy} onClick={enroll} style={{ width: "100%" }}>
            {busy ? "Preparing…" : "Set up authenticator app"}
          </button>
        ) : (
          <form onSubmit={verify}>
            {enrollment ? (
              <>
                <p style={{ marginBottom: "0.5rem" }}>Scan this code with your authenticator app, then enter the 6-digit code it shows.</p>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={enrollment.qrCode} alt="Authenticator QR code" width={180} height={180} style={{ display: "block", margin: "0 auto" }} />
                <label htmlFor="mfa-secret">Or enter this setup key</label>
                <input id="mfa-secret" readOnly value={enrollment.secret} onFocus={(e) => e.currentTarget.select()} />
              </>
            ) : null}
            <label htmlFor="mfa-code">6-digit code</label>
            <input
              id="mfa-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              required
            />
            <button className="btn" type="submit" disabled={busy || code.length !== 6} style={{ width: "100%", marginTop: "1rem" }}>
              {busy ? "Verifying…" : "Verify"}
            </button>
          </form>
        )}
        <button className="btn secondary" type="button" disabled={busy} onClick={signOut} style={{ width: "100%", marginTop: "1rem" }}>
          Sign out
        </button>
      </div>
    </div>
  );
}
