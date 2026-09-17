/** Normalized sync domain models for the $297 webhook-backed dashboard. */

export const SYNC_EVENT_TYPES = [
  "lead.created",
  "lead.updated",
  "lead.reply",
  "lead.qualified",
  "opportunity.created",
  "opportunity.updated",
  "opportunity.stage_changed",
  "opportunity.won",
  "opportunity.lost",
  "appointment.booked",
  "appointment.rescheduled",
  "appointment.cancelled",
  "appointment.no_show",
  "appointment.completed",
  "conversation.inbound",
  "conversation.outbound",
  "conversation.handoff",
  "review.requested",
  "review.feedback_received",
  "task.created",
  "task.completed",
  "system.workflow_event",
] as const;

export type SyncEventType = (typeof SYNC_EVENT_TYPES)[number];

export type ContactRecord = {
  externalContactId: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  email?: string;
  phone?: string;
  source?: string;
  tags: string[];
  assignedUser?: string;
  createdAt?: string;
  updatedAt: string;
};

export type OpportunityRecord = {
  externalOpportunityId: string;
  contactId?: string;
  pipelineId?: string;
  stageId?: string;
  stageName?: string;
  status?: string;
  monetaryValue?: number;
  assignedUser?: string;
  createdAt?: string;
  updatedAt: string;
};

export type AppointmentRecord = {
  externalAppointmentId: string;
  contactId?: string;
  calendarId?: string;
  calendarName?: string;
  status?: string;
  start?: string;
  end?: string;
  timezone?: string;
  assignedUser?: string;
  createdAt?: string;
  updatedAt: string;
};

export type ConversationEventRecord = {
  id: string;
  contactId?: string;
  direction?: "inbound" | "outbound" | "unknown";
  channel?: string;
  eventType: string;
  timestamp: string;
  summary?: string;
  metadata?: Record<string, string>;
};

export type TaskEventRecord = {
  id: string;
  contactId?: string;
  opportunityId?: string;
  type?: string;
  status?: string;
  assignedUser?: string;
  timestamp: string;
};

export type ReviewEventRecord = {
  id: string;
  contactId?: string;
  kind: "review-requested" | "feedback-received";
  resultStatus?: string;
  timestamp: string;
};

export type AuditEventRecord = {
  id: string;
  idempotencyKey: string;
  eventType: SyncEventType;
  locationId: string;
  receivedAt: string;
  sourceEventName?: string;
  entityRefs: {
    contactId?: string;
    opportunityId?: string;
    appointmentId?: string;
  };
  /** Non-PII processing notes only */
  note?: string;
};

export type SyncSnapshot = {
  contacts: Record<string, ContactRecord>;
  opportunities: Record<string, OpportunityRecord>;
  appointments: Record<string, AppointmentRecord>;
  conversationEvents: ConversationEventRecord[];
  taskEvents: TaskEventRecord[];
  reviewEvents: ReviewEventRecord[];
  auditTrail: AuditEventRecord[];
  idempotencyKeys: string[];
  lastEventAt?: string;
  updatedAt: string;
};

export type DashboardSummary = {
  contactsCount: number;
  opportunitiesCount: number;
  appointmentsCount: number;
  conversationEventsCount: number;
  openPipelineValue: number;
  wonCount: number;
  lastEventAt?: string;
  waitingForSync: boolean;
};

export type InboundSyncPayload = {
  event?: string;
  type?: string;
  eventType?: string;
  event_name?: string;
  locationId?: string;
  location_id?: string;
  idempotencyKey?: string;
  idempotency_key?: string;
  eventId?: string;
  event_id?: string;
  occurredAt?: string;
  occurred_at?: string;
  timestamp?: string;
  contact?: Record<string, unknown>;
  opportunity?: Record<string, unknown>;
  appointment?: Record<string, unknown>;
  conversation?: Record<string, unknown>;
  task?: Record<string, unknown>;
  review?: Record<string, unknown>;
  contactId?: string;
  contact_id?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  email?: string;
  phone?: string;
  source?: string;
  tags?: string[] | string;
  assignedUser?: string;
  assigned_user?: string;
  opportunityId?: string;
  opportunity_id?: string;
  pipelineId?: string;
  pipeline_id?: string;
  stageId?: string;
  stage_id?: string;
  stageName?: string;
  stage_name?: string;
  status?: string;
  monetaryValue?: number | string;
  monetary_value?: number | string;
  appointmentId?: string;
  appointment_id?: string;
  calendarId?: string;
  calendar_id?: string;
  calendarName?: string;
  start?: string;
  end?: string;
  timezone?: string;
  direction?: string;
  channel?: string;
  summary?: string;
  resultStatus?: string;
  result_status?: string;
  workflowId?: string;
  workflow_id?: string;
  workflowName?: string;
  workflow_name?: string;
  [key: string]: unknown;
};
