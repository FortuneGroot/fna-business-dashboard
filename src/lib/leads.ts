import { loadEnv } from "./env";
import { isFakeEmail, type InboundLead } from "./mapping";

const FAKE_PHONE_PREFIXES = ["555", "000", "111"];

export type ValidationResult = { ok: true; lead: InboundLead } | { ok: false; errors: string[] };

export function validateInboundLead(raw: unknown): ValidationResult {
  const env = loadEnv();
  if (!raw || typeof raw !== "object") {
    return { ok: false, errors: ["Body must be a JSON object."] };
  }
  const body = raw as Record<string, unknown>;
  const errors: string[] = [];
  const email = String(body.email || "").trim();
  const phone = String(body.phone || "").trim();
  const name = String(body.name || body.firstName || "").trim();

  if (!name) errors.push("Name is required.");
  if (!email && !phone) errors.push("Email or phone is required.");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("Email is not valid.");

  if (env.fakeContactOnly || env.dryRun) {
    if (email && !isFakeEmail(email)) {
      errors.push("Dry-run / fake-contact mode only accepts @example.invalid or @example.com.");
    }
    const digits = phone.replace(/\D/g, "");
    if (phone && digits.length >= 10 && !FAKE_PHONE_PREFIXES.some((p) => digits.includes(p))) {
      errors.push("Dry-run only accepts clearly fake phones (contain 555 / 000 / 111).");
    }
  }

  if (errors.length) return { ok: false, errors };

  const utm: Record<string, string> = {};
  if (body.utm && typeof body.utm === "object") {
    for (const [k, v] of Object.entries(body.utm as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) utm[k] = v.trim();
    }
  }

  return {
    ok: true,
    lead: {
      firstName: String(body.firstName || "").trim() || undefined,
      lastName: String(body.lastName || "").trim() || undefined,
      name,
      email: email || undefined,
      phone: phone || undefined,
      message: String(body.message || "").trim() || undefined,
      service: String(body.service || "").trim() || undefined,
      preferredContactMethod: String(body.preferredContactMethod || "").trim() || undefined,
      smsServiceConsent: Boolean(body.smsServiceConsent),
      smsMarketingConsent: Boolean(body.smsMarketingConsent),
      emailMarketingConsent: Boolean(body.emailMarketingConsent),
      source: String(body.source || "website"),
      page: String(body.page || ""),
      utm,
    },
  };
}
