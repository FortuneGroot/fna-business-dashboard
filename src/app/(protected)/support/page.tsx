"use client";

import { AppShell } from "@/components/AppShell";
import { Card, PageHead, Button, LoadError } from "@/components/ui";
import { BRAND } from "@/lib/brand";
import { markWorkspaceStale, workspaceHeaders } from "@/lib/ui/workspace-pin";
import { useCallback, useEffect, useState } from "react";

type TenantContact = {
  businessName?: string;
  supportEmail?: string;
  phone?: string;
  website?: string;
};

export default function SupportPage() {
  const [contact, setContact] = useState<TenantContact>({ businessName: BRAND.name });
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState("");

  const load = useCallback(async () => {
    setLoadState("loading");
    setErrorMessage("");
    try {
      const res = await fetch("/api/tenant/config", { cache: "no-store", headers: workspaceHeaders() });
      if (res.status === 401 || res.status === 403) {
        setLoadState("error");
        setErrorMessage("Your session expired or you are not signed in.");
        return;
      }
      if (res.status === 409) {
        markWorkspaceStale();
        setLoadState("error");
        setErrorMessage("You switched to a different business in another tab. Reload this page to continue.");
        return;
      }
      if (!res.ok) {
        setLoadState("error");
        setErrorMessage("Could not load support contact details.");
        return;
      }
      const d = await res.json();
      if (d?.client) {
        setContact({
          businessName: d.client.businessName || BRAND.name,
          supportEmail: d.client.supportEmail || "",
          phone: d.client.phone || "",
          website: d.client.website || "",
        });
      }
      setLoadState("ready");
    } catch {
      setLoadState("error");
      setErrorMessage("Network error while loading support details.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const bizName = contact.businessName || BRAND.name;
  const email = contact.supportEmail || "";
  const phone = contact.phone || "";
  const website = contact.website || "";
  const hasChannels = Boolean(email || phone || website);

  return (
    <AppShell>
      <PageHead
        title="Support / Contact"
        description={`Reach ${bizName} using the channels below.`}
      />

      {loadState === "error" ? <LoadError message={errorMessage} onRetry={load} /> : null}

      <div className="grid grid-2">
        <Card title="Contact channels">
          {loadState === "loading" ? (
            <p className="muted" role="status">
              Loading contact details…
            </p>
          ) : loadState === "error" ? (
            <p className="muted">Contact details could not be loaded.</p>
          ) : hasChannels ? (
            <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
              {email ? (
                <li>
                  Email:{" "}
                  <a href={`mailto:${email}`}>{email}</a>
                </li>
              ) : null}
              {phone ? <li>Phone: {phone}</li> : null}
              {website ? (
                <li>
                  Website:{" "}
                  <a href={website.startsWith("http") ? website : `https://${website}`} rel="noreferrer" target="_blank">
                    {website.replace(/^https?:\/\//, "")}
                  </a>
                </li>
              ) : null}
            </ul>
          ) : (
            <p className="muted">
              Support channels are not configured for this client yet. Contact Fortune & Automations
              if you need help.
            </p>
          )}
        </Card>

        <Card title="Request help">
          <p>
            There is no in-app request form on this page yet. Use the contact channels on the left,
            or open Help for training and resources.
          </p>
          <div className="quick-actions" style={{ marginTop: "0.8rem" }}>
            <Button variant="secondary" href="/help">
              Help &amp; Support
            </Button>
            {email ? (
              <Button variant="primary" href={`mailto:${email}`}>
                Email support
              </Button>
            ) : null}
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
