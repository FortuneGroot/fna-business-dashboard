/** Website form → Vercel → CRM field map. IDs from recovered Sept 11–12 LIVE checkpoint only. */

export const LIVE_LOCATION_ID = "kIXDnRuhkj6HLR1g6V6V";
export const LIVE_PIPELINE_ID = "6XevPh4T3rX0qAYRfuta";
export const FORBIDDEN_MASTER_ID = "NQwD3zdWCuBSVpOuzybj";
export const OLD_PIPELINE_ID = "iYIxeKOdg5jkoAfKNnYM";

export const FIELD_MAP = {
  service_interested_in: { name: "Service Interested In", id: "eGFcHQ1s4RLlUYkGNPLF" },
  best_contact_time: { name: "Best Contact Time", id: "Pldm70tcQ8qPbJr22h32" },
  active_sequence: { name: "Active Sequence", id: "Q5EyGmpJAMM56rbpmxzL" },
  initial_inquiry: { name: "Initial Inquiry", id: "obngwGUbP9AHt2CuBRMV" },
  human_followup_required: { name: "Human follow-up required", id: "d831xHAWXLWejAbeYVxZ" },
  sms_service_consent: { name: "SMS service consent", id: "k7bYDjP8GdoWntlEr6CP" },
  sms_marketing_consent: { name: "SMS marketing consent", id: "eA7KEjSsMs2wjJgXeNnn" },
  preferred_contact_method: { name: "Preferred Contact Method", id: "af4I569uv4c1M8kZkT1U" },
  timeline: { name: "Timeline", id: "TYUQYWJe2I88GCaBc5BT" },
  service_address: { name: "Service Address", id: "lF4cmXkmaXsj8QY1YGG7" },
  customer_type: { name: "Customer Type", id: "XcKDxkNcBqqY6EOjOvn9" },
  email_marketing_permission: { name: "Email Marketing Permission", id: "MrqMzPurFZywYbjCRDdT" },
  consent_evidence_reference: { name: "Consent Evidence Reference", id: "pZJjiRWGrv5zabxB8Hzt" },
} as const;

export const NATIVE_FIELDS = [
  "firstName",
  "lastName",
  "name",
  "email",
  "phone",
  "source",
  "city",
  "state",
  "postalCode",
  "address1",
  "website",
] as const;

export const FORM_SHELLS = [
  { id: "WYQJlUcvBCjtAQbh5y41", intended: "01 | General Contact Form", listName: "Form 0" },
  { id: "4ULhasDaYHJGE4SSptcW", intended: "01/05 native Contact Us", listName: "Contact Us" },
  { id: "1MEcqR1xTiYSShWrCM5D", intended: "02 | Quote / Estimate Request", listName: "Form 2" },
  { id: "dvfQRpPx0hcz0yDMtGM1", intended: "03 | Appointment Intake", listName: "Form 3" },
  { id: "PyF5UHJ78VZ5tPTLneqS", intended: "05 | Detailed Qualification Form", listName: "Form 4" },
] as const;

export const FORM_004_STATUS = "NOT_ON_PLATFORM — dedicated Customer Feedback shell still missing";

/** @deprecated Prefer getConsentCopy() so client business name resolves from tenant config. */
export const CONSENT_COPY = {
  smsService:
    "I agree to receive texts from {{CLIENT_BUSINESS_NAME}} about my request and appointments. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help.",
  smsMarketing:
    "I agree to receive marketing texts from {{CLIENT_BUSINESS_NAME}}. Consent is not a condition of purchase. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help.",
  emailMarketing:
    "I agree to receive email updates from {{CLIENT_BUSINESS_NAME}} about my request. I can unsubscribe at any time.",
};

export function applyClientBusinessName(template: string, businessName: string): string {
  return template.replace(/\{\{CLIENT_BUSINESS_NAME\}\}/g, businessName);
}

export function getConsentCopy(businessName: string) {
  return {
    smsService: applyClientBusinessName(CONSENT_COPY.smsService, businessName),
    smsMarketing: applyClientBusinessName(CONSENT_COPY.smsMarketing, businessName),
    emailMarketing: applyClientBusinessName(CONSENT_COPY.emailMarketing, businessName),
  };
}

export const UTM_FIELDS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "gclid", "fbclid"] as const;

export type InboundLead = {
  firstName?: string;
  lastName?: string;
  name?: string;
  email?: string;
  phone?: string;
  message?: string;
  service?: string;
  preferredContactMethod?: string;
  smsServiceConsent?: boolean;
  smsMarketingConsent?: boolean;
  emailMarketingConsent?: boolean;
  source?: string;
  page?: string;
  utm?: Record<string, string>;
};

export function normalizePhone(phone?: string): string {
  return (phone || "").replace(/\D/g, "");
}

export function isFakeEmail(email?: string): boolean {
  const e = (email || "").toLowerCase();
  return e.endsWith("@example.invalid") || e.endsWith("@example.com");
}

export function dedupeKey(lead: InboundLead): string {
  const email = (lead.email || "").trim().toLowerCase();
  const phone = normalizePhone(lead.phone);
  return `email:${email}|phone:${phone}`;
}

export function mapLeadToGhlPayload(lead: InboundLead): Record<string, unknown> {
  const customFields = [
    lead.service
      ? { id: FIELD_MAP.service_interested_in.id, value: lead.service }
      : null,
    lead.message ? { id: FIELD_MAP.initial_inquiry.id, value: lead.message } : null,
    lead.preferredContactMethod
      ? { id: FIELD_MAP.preferred_contact_method.id, value: lead.preferredContactMethod }
      : null,
    {
      id: FIELD_MAP.sms_service_consent.id,
      value: lead.smsServiceConsent ? "Yes" : "No",
    },
    {
      id: FIELD_MAP.sms_marketing_consent.id,
      value: lead.smsMarketingConsent ? "Yes" : "No",
    },
    {
      id: FIELD_MAP.email_marketing_permission.id,
      value: lead.emailMarketingConsent ? "Granted" : "Unknown",
    },
  ].filter(Boolean);

  return {
    locationId: LIVE_LOCATION_ID,
    firstName: lead.firstName,
    lastName: lead.lastName,
    name: lead.name,
    email: lead.email,
    phone: lead.phone,
    source: lead.source || "website",
    tags: ["source-website", "lead-new"],
    customFields,
    utm: lead.utm || {},
    pipelineId: LIVE_PIPELINE_ID,
    stageName: "New Lead",
  };
}
