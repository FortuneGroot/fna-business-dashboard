import { SYNC_EVENT_TYPES, type SyncEventType } from "./types";

/** Map GHL workflow / custom webhook names → dashboard domain events. */
const ALIASES: Record<string, SyncEventType> = {
  "lead.created": "lead.created",
  "lead.updated": "lead.updated",
  "lead.reply": "lead.reply",
  "lead.qualified": "lead.qualified",
  "opportunity.created": "opportunity.created",
  "opportunity.updated": "opportunity.updated",
  "opportunity.stage_changed": "opportunity.stage_changed",
  "opportunity.won": "opportunity.won",
  "opportunity.lost": "opportunity.lost",
  "appointment.booked": "appointment.booked",
  "appointment.rescheduled": "appointment.rescheduled",
  "appointment.cancelled": "appointment.cancelled",
  "appointment.no_show": "appointment.no_show",
  "appointment.noshow": "appointment.no_show",
  "appointment.completed": "appointment.completed",
  "conversation.inbound": "conversation.inbound",
  "conversation.outbound": "conversation.outbound",
  "conversation.handoff": "conversation.handoff",
  "review.requested": "review.requested",
  "review.feedback_received": "review.feedback_received",
  "task.created": "task.created",
  "task.completed": "task.completed",
  "system.workflow_event": "system.workflow_event",

  // Common HighLevel / workflow aliases (normalized, lowercased)
  contactcreate: "lead.created",
  contact_create: "lead.created",
  contactcreated: "lead.created",
  "contact.created": "lead.created",
  contactupdate: "lead.updated",
  contact_update: "lead.updated",
  "contact.updated": "lead.updated",
  customerreplied: "lead.reply",
  customer_replied: "lead.reply",
  "customer.replied": "lead.reply",
  opportunitycreate: "opportunity.created",
  opportunity_create: "opportunity.created",
  "opportunity.status_changed": "opportunity.stage_changed",
  opportunitystatusupdate: "opportunity.stage_changed",
  stagechanged: "opportunity.stage_changed",
  appointmentcreate: "appointment.booked",
  "appointment.created": "appointment.booked",
  appointmentbooked: "appointment.booked",
  appointmentupdate: "appointment.rescheduled",
  appointmentcancel: "appointment.cancelled",
  appointmentnoshow: "appointment.no_show",
  inboundmessage: "conversation.inbound",
  outboundmessage: "conversation.outbound",
  handoff: "conversation.handoff",
  reviewrequest: "review.requested",
  feedbackreceived: "review.feedback_received",
};

export function normalizeEventName(raw: unknown): SyncEventType | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if ((SYNC_EVENT_TYPES as readonly string[]).includes(lower)) {
    return lower as SyncEventType;
  }
  const compact = lower.replace(/[\s-]+/g, "_");
  if (ALIASES[lower]) return ALIASES[lower];
  if (ALIASES[compact]) return ALIASES[compact];
  // dotted aliases already covered; try stripping spaces
  const dotted = lower.replace(/\s+/g, ".");
  if (ALIASES[dotted]) return ALIASES[dotted];
  return null;
}

export function isKnownSyncEvent(type: string): type is SyncEventType {
  return (SYNC_EVENT_TYPES as readonly string[]).includes(type);
}
