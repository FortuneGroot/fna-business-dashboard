// API-1: the pre-migration /api/dashboard/* response shapes (src/lib/data/dashboard-api.ts, which
// mirrors the legacy route mappings) as runtime schemas. A response passes only if every required key
// has the right type and there are no extra keys. Shared by the unit and real-stack suites.

type Kind = "string" | "number" | "boolean" | "true" | "string[]" | "number|null" | "redacted" | "refs";
type Field = Kind | `${Kind}?`;
type Shape = Record<string, Field>;

const META: Shape = { ok: "true", source: "string", storageMode: "string" };

export const SUMMARY: Shape = {
  contactsCount: "number", opportunitiesCount: "number", appointmentsCount: "number",
  conversationEventsCount: "number", openPipelineValue: "number", wonCount: "number",
  lastEventAt: "string?", waitingForSync: "boolean",
};

const ROWS = {
  contacts: {
    id: "string", displayName: "string", email: "redacted?", phone: "redacted?", hasEmail: "boolean",
    hasPhone: "boolean", source: "string", tags: "string[]", assignedUser: "string", updatedAt: "string",
  },
  opportunities: {
    id: "string", contactId: "string", pipelineId: "string", stageId: "string", stageName: "string",
    status: "string", monetaryValue: "number|null", assignedUser: "string", updatedAt: "string",
  },
  appointments: {
    id: "string", contactId: "string", calendarId: "string", calendarName: "string", status: "string",
    start: "string", end: "string", timezone: "string", assignedUser: "string", updatedAt: "string",
  },
  conversations: {
    id: "string", contactId: "string", direction: "string", channel: "string", eventType: "string",
    timestamp: "string", summary: "string",
  },
  events: {
    id: "string", eventType: "string", receivedAt: "string", locationId: "string", entityRefs: "refs", note: "string",
  },
} satisfies Record<string, Shape>;

export type DashboardEndpoint = "summary" | keyof typeof ROWS;
export const DASHBOARD_ENDPOINTS: DashboardEndpoint[] = ["summary", "contacts", "opportunities", "appointments", "conversations", "events"];

function kindOk(kind: Kind, v: unknown): boolean {
  switch (kind) {
    case "true": return v === true;
    case "string[]": return Array.isArray(v) && v.every((x) => typeof x === "string");
    case "number|null": return v === null || typeof v === "number";
    case "redacted": return v === "[redacted]";
    case "refs":
      return typeof v === "object" && v !== null && !Array.isArray(v) &&
        Object.entries(v).every(([k, x]) => ["contactId", "opportunityId", "appointmentId"].includes(k) && typeof x === "string");
    default: return typeof v === kind;
  }
}

export function shapeErrors(value: unknown, shape: Shape, at: string): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [`${at}: not an object`];
  const obj = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const [key, field] of Object.entries(shape)) {
    const optional = field.endsWith("?");
    const kind = field.replace(/\?$/, "") as Kind;
    if (!(key in obj)) {
      if (!optional) errors.push(`${at}.${key}: missing`);
      continue;
    }
    if (!kindOk(kind, obj[key])) errors.push(`${at}.${key}: expected ${field}, got ${JSON.stringify(obj[key])}`);
  }
  for (const key of Object.keys(obj)) if (!(key in shape)) errors.push(`${at}.${key}: unexpected key`);
  return errors;
}

/** Errors for a /api/dashboard/<endpoint> body against its pre-migration shape (empty = valid). */
export function dashboardShapeErrors(endpoint: DashboardEndpoint, body: unknown): string[] {
  if (endpoint === "summary") {
    const errors = shapeErrors(body, { ...META, summary: "string" }, "body").filter((e) => !e.startsWith("body.summary"));
    return [...errors, ...shapeErrors((body as { summary?: unknown })?.summary, SUMMARY, "summary")];
  }
  const errors = shapeErrors(body, { ...META, [endpoint]: "string", waitingForSync: "boolean" }, "body")
    .filter((e) => !e.startsWith(`body.${endpoint}:`));
  const list = (body as Record<string, unknown>)?.[endpoint];
  if (!Array.isArray(list)) return [...errors, `body.${endpoint}: not an array`];
  return [...errors, ...list.flatMap((row, i) => shapeErrors(row, ROWS[endpoint], `${endpoint}[${i}]`))];
}
