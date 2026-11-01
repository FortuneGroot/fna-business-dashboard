/** Record shapes shared by the dashboard readers (native tables and the legacy snapshot) and /api/dashboard/*. */

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

export type StorageMode = "memory" | "postgres";

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
  /** The reader's partition: the workspace id for native data, the deployment partition for the legacy snapshot. */
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
