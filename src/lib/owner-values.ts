/**
 * OWNER VALUES — single insertion point per key.
 * Leave unset until the owner supplies a verified live value.
 * Do not invent emails, URLs, or ZIP codes.
 *
 * CRM Custom Value keys (GHL) for the same facts:
 *   Support Email            → FNA | Support Email
 *   Lead Notification Email  → FNA | Lead Notification Email
 *   Logo URL                 → FNA | Logo URL
 *   Booking URL              → FNA | Booking URL
 *   Reschedule URL           → FNA | Reschedule URL
 *   Review URL               → FNA | Review URL
 *   ZIP                      → FNA | ZIP
 */

export type OwnerValueKey =
  | "supportEmail"
  | "leadNotificationEmail"
  | "logoUrl"
  | "bookingUrl"
  | "rescheduleUrl"
  | "reviewUrl"
  | "zip";

export type OwnerValue = {
  key: OwnerValueKey;
  label: string;
  ghlCustomValueName: string;
  /** Empty string = owner value still required. */
  value: string;
};

export const OWNER_VALUES: Record<OwnerValueKey, OwnerValue> = {
  supportEmail: {
    key: "supportEmail",
    label: "Support Email",
    ghlCustomValueName: "FNA | Support Email",
    value: "",
  },
  leadNotificationEmail: {
    key: "leadNotificationEmail",
    label: "Lead Notification Email",
    ghlCustomValueName: "FNA | Lead Notification Email",
    value: "",
  },
  logoUrl: {
    key: "logoUrl",
    label: "Logo URL",
    ghlCustomValueName: "FNA | Logo URL",
    value: "",
  },
  bookingUrl: {
    key: "bookingUrl",
    label: "Booking URL",
    ghlCustomValueName: "FNA | Booking URL",
    value: "",
  },
  rescheduleUrl: {
    key: "rescheduleUrl",
    label: "Reschedule URL",
    ghlCustomValueName: "FNA | Reschedule URL",
    value: "",
  },
  reviewUrl: {
    key: "reviewUrl",
    label: "Review URL",
    ghlCustomValueName: "FNA | Review URL",
    value: "",
  },
  zip: {
    key: "zip",
    label: "ZIP",
    ghlCustomValueName: "FNA | ZIP",
    value: "",
  },
};

export function ownerValue(key: OwnerValueKey): string {
  return OWNER_VALUES[key].value.trim();
}

export function missingOwnerValues(): OwnerValue[] {
  return Object.values(OWNER_VALUES).filter((v) => !v.value.trim());
}
