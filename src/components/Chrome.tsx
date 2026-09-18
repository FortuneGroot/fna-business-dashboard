"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BRAND } from "@/lib/brand";

type TenantChrome = {
  client?: { businessName?: string; legalBusinessName?: string };
  platform?: { brandName?: string; productName?: string; legal?: string };
};

export function Footer() {
  const [tenant, setTenant] = useState<TenantChrome | null>(null);
  useEffect(() => {
    fetch("/api/tenant/public")
      .then((r) => r.json())
      .then(setTenant)
      .catch(() => undefined);
  }, []);

  const platform = tenant?.platform?.brandName || BRAND.name;
  const clientLegal =
    tenant?.client?.legalBusinessName || tenant?.platform?.legal || BRAND.legal;

  return (
    <footer className="app-footer">
      <div className="footer-inner">
        <div>
          {platform} · {clientLegal}
          <div className="muted">
            Product: {tenant?.platform?.productName || BRAND.product}
          </div>
        </div>
        <div>
          <Link href="/privacy">Privacy</Link>
          {" · "}
          <Link href="/terms">Terms</Link>
          {" · "}
          <Link href="/support">Contact</Link>
        </div>
      </div>
    </footer>
  );
}

export function StatusBanner({ children }: { children: React.ReactNode }) {
  return <div className="banner">{children}</div>;
}
