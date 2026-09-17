"use client";

import { AppShell } from "@/components/AppShell";
import { PageHead, Button } from "@/components/ui";
import { BRAND } from "@/lib/brand";
import { CONSENT_COPY } from "@/lib/mapping";
import { FormEvent, useState } from "react";

export default function SupportPage() {
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setStatus("Sending dry-run…");
    const form = new FormData(e.currentTarget);
    const payload = {
      name: String(form.get("name") || ""),
      email: String(form.get("email") || ""),
      phone: String(form.get("phone") || ""),
      service: String(form.get("service") || ""),
      message: String(form.get("message") || ""),
      preferredContactMethod: String(form.get("preferred") || ""),
      smsServiceConsent: form.get("smsService") === "on",
      smsMarketingConsent: form.get("smsMarketing") === "on",
      source: "app-support",
      page: "/support",
    };
    const res = await fetch("/api/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      setStatus("");
      setError((data.errors || [data.error || "Request failed"]).join(" "));
      return;
    }
    setStatus(data.message || "Recorded in dry-run. No production contact was created.");
  }

  return (
    <AppShell>
      <PageHead
        title="Support / Contact"
        description={`Contact Fortune & Automations. Recovered from the training pack — confirm live before publishing: ${BRAND.supportEmailRecovered} · ${BRAND.supportPhoneRecovered} · ${BRAND.website.replace("https://", "")}`}
      />
      <p className="muted">
        This form posts to a dry-run lead API. Use a fake email such as{" "}
        <code>qa.lead@example.invalid</code> and a 555 phone. No production contact write.
      </p>
      <form className="card" onSubmit={onSubmit}>
        <label htmlFor="name">Full name</label>
        <input id="name" name="name" required placeholder="QA Test Lead" />
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" placeholder="qa.lead@example.invalid" />
        <label htmlFor="phone">Phone</label>
        <input id="phone" name="phone" placeholder="555-010-0199" />
        <label htmlFor="service">Service interested in</label>
        <select id="service" name="service" defaultValue="">
          <option value="">Select…</option>
          <option>Automation</option>
          <option>Websites</option>
          <option>Branding</option>
          <option>Systems</option>
        </select>
        <label htmlFor="preferred">Preferred contact method</label>
        <select id="preferred" name="preferred" defaultValue="Email">
          <option>Email</option>
          <option>SMS</option>
          <option>Phone</option>
        </select>
        <label htmlFor="message">Message</label>
        <textarea id="message" name="message" placeholder="How can we help?" />
        <label className="check">
          <input type="checkbox" name="smsService" />
          <span>{CONSENT_COPY.smsService}</span>
        </label>
        <label className="check">
          <input type="checkbox" name="smsMarketing" />
          <span>{CONSENT_COPY.smsMarketing}</span>
        </label>
        <div style={{ marginTop: "1rem" }}>
          <Button type="submit">Send my request (dry-run)</Button>
        </div>
        {status ? <p className="banner">{status}</p> : null}
        {error ? <p className="banner error">{error}</p> : null}
      </form>
    </AppShell>
  );
}
