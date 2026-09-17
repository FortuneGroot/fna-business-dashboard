"use client";

import { FormEvent, useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BRAND } from "@/lib/brand";

type TenantPublic = {
  client?: { businessName?: string };
  platform?: { productName?: string; brandName?: string };
};

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const nextPath = params.get("next") || "/dashboard";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tenant, setTenant] = useState<TenantPublic | null>(null);
  const [authReady, setAuthReady] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/tenant/public")
      .then((r) => r.json())
      .then(setTenant)
      .catch(() => undefined);
    fetch("/api/auth/me")
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        setAuthReady(Boolean(data.authEnforced));
        if (r.ok && data.user) router.replace(nextPath);
      })
      .catch(() => setAuthReady(false));
  }, [nextPath, router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Login failed");
        setBusy(false);
        return;
      }
      router.replace(nextPath.startsWith("/") ? nextPath : "/dashboard");
    } catch {
      setError("Login request failed");
      setBusy(false);
    }
  }

  const product = tenant?.platform?.productName || BRAND.product;
  const clientName = tenant?.client?.businessName || BRAND.name;

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="brand-lockup" style={{ justifyContent: "center" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="brand-logo" src="/fna-logo.jpg" alt="" width={42} height={42} />
        </div>
        <h1 className="serif" style={{ textAlign: "center", fontSize: "1.35rem" }}>
          {product}
        </h1>
        <p className="muted" style={{ textAlign: "center", marginTop: 0 }}>
          Client: <strong style={{ color: "var(--primary)" }}>{clientName}</strong>
        </p>

        {authReady === false ? (
          <div className="banner">
            Authentication is not enforced on this deployment yet. Set{" "}
            <code>AUTH_SECRET</code> and owner credentials in the environment to enable login.
            Preview may still use Vercel Deployment Protection.
          </div>
        ) : null}

        {error ? <div className="banner error">{error}</div> : null}

        <form onSubmit={onSubmit}>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={authReady === false}
          />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            disabled={authReady === false}
          />
          <button className="btn" type="submit" disabled={busy || authReady === false} style={{ width: "100%", marginTop: "1rem" }}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="muted" style={{ marginTop: "1rem", fontSize: "0.85rem" }}>
          Roles: Owner / Admin / Client. Credentials are never stored in this repository.
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="login-wrap"><div className="login-card">Loading…</div></div>}>
      <LoginForm />
    </Suspense>
  );
}
