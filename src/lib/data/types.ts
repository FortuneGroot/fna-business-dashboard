import type {
  AppointmentRecord,
  AuditEventRecord,
  ContactRecord,
  ConversationEventRecord,
  DashboardSummary,
  OpportunityRecord,
  ReviewEventRecord,
  TaskEventRecord,
} from "@/lib/sync/types";
import type { StorageMode } from "@/lib/sync/store";

/**
 * Read surface shared by pages and /api/dashboard/*. With AUTH_PROVIDER=legacy it is the sync store;
 * with AUTH_PROVIDER=supabase it reads the active workspace's native tables (spec §9.2 P3).
 */
export type DashboardReader = {
  readonly native: boolean;
  /** `source` and `storageMode` values reported by /api/dashboard/* responses. */
  readonly source: "sync-store" | "workspace";
  readonly storageMode: StorageMode;
  summary(): Promise<DashboardSummary>;
  /** Same value as summary().waitingForSync, without the totals. */
  waitingForSync(): Promise<boolean>;
  listContacts(): Promise<ContactRecord[]>;
  listOpportunities(): Promise<OpportunityRecord[]>;
  listAppointments(): Promise<AppointmentRecord[]>;
  listConversationEvents(limit?: number): Promise<ConversationEventRecord[]>;
  listTaskEvents(limit?: number): Promise<TaskEventRecord[]>;
  listReviewEvents(limit?: number): Promise<ReviewEventRecord[]>;
  listAuditEvents(limit?: number): Promise<AuditEventRecord[]>;
};

export type WorkspaceCalendar = { id: string; name: string; duration: string };

/** A board column of the default pipeline. Opportunities belong to a column by `id`, never by name. */
export type WorkspaceStage = { id: string; name: string; kind: string };

/** Non-deleted opportunities per stage id, with values in cents (exact, not limited by list caps). */
export type StageTotals = ReadonlyMap<string, { count: number; valueCents: number }>;

/** Workspace identity and configuration shown by pages and /api/tenant/config. */
export type WorkspaceView = {
  businessName: string;
  legalName: string;
  timezone: string;
  industry: string;
  supportEmail: string;
  phone: string;
  website: string;
  bookingUrl: string;
  reviewUrl: string;
  pipelineName: string;
  stageNames: string[];
  /** Native only (empty in legacy mode, whose config has names only). */
  stages: WorkspaceStage[];
  stagesConfigured: boolean;
  calendars: WorkspaceCalendar[];
  calendarsConfigured: boolean;
};

export type DataSource = {
  readonly native: boolean;
  readonly reader: DashboardReader;
  workspace(): Promise<WorkspaceView>;
  /** Native only: exact per-stage totals for the default pipeline. Legacy mode returns an empty map. */
  stageTotals(): Promise<StageTotals>;
  /** Whether the caller holds `permission` (always false in legacy mode, which has no permissions). */
  can(permission: string): boolean;
};
