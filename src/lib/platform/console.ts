import "server-only";
import { z } from "zod";
import { check, decodeCursor, encodeCursor, pageQuery, uuid } from "@/lib/api/native";
import type { PlatformScope } from "@/lib/api/platform";

export const WORKSPACE_STATUSES = ["active", "suspended", "archived"] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

const reason = z
  .string({ message: "Give a reason" })
  .trim()
  .min(10, "Give a reason of at least 10 characters")
  .max(500, "Keep the reason under 500 characters");

export const reasonBody = z.strictObject({ reason });

export const provisionBody = z.strictObject({
  provisioningKey: z
    .string()
    .trim()
    .min(3, "At least 3 characters")
    .max(120)
    .regex(/^[a-z0-9][a-z0-9._-]*$/i, "Letters, digits, dots, dashes, or underscores"),
  name: z.string().trim().min(1, "Enter the business name").max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/, "3–48 lowercase letters, digits, or hyphens"),
  ownerEmail: z.string().trim().toLowerCase().max(254).pipe(z.email({ message: "Enter a valid email address" })),
});

export const accessBody = z.strictObject({
  mode: z.enum(["read", "write"]),
  reason,
  durationMinutes: z.number().int().min(1, "At least 1 minute").max(480, "At most 8 hours (480 minutes)"),
});

export const workspaceQuery = z.strictObject({
  q: z.string().trim().max(100).optional(),
  status: z.enum(WORKSPACE_STATUSES).optional(),
  ...pageQuery,
});

export const auditQuery = z.strictObject({ ...pageQuery });

export const grantsQuery = z.strictObject({ include: z.enum(["active", "all"]).default("active") });

export type WorkspaceSummary = {
  id: string;
  name: string;
  slug: string;
  status: WorkspaceStatus;
  createdAt: string;
  memberCount: number;
  ownerJoined: boolean;
};

export type WorkspaceDetail = {
  id: string;
  name: string;
  slug: string;
  status: WorkspaceStatus;
  createdAt: string;
  suspendedAt: string | null;
  suspendedReason: string | null;
  bootstrapOwnerEmail: string;
  ownerAcquiredAt: string | null;
  members: { owner: number; admin: number; employee: number };
  openOwnerInvitation: { id: string; createdAt: string; expiresAt: string } | null;
  canRotateBootstrap: boolean;
};

export type AccessGrant = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  workspaceStatus: WorkspaceStatus;
  adminEmail: string | null;
  mode: "read" | "write";
  reason: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  active: boolean;
  mine: boolean;
};

export type AuditEntry = {
  id: number;
  createdAt: string;
  action: string;
  reason: string | null;
  metadata: Record<string, unknown>;
  workspaceId: string | null;
  workspaceName: string | null;
  actorEmail: string | null;
};

type RawSummary = { id: string; name: string; slug: string; status: WorkspaceStatus; created_at: string; member_count: number; owner_joined: boolean };
type RawDetail = {
  id: string; name: string; slug: string; status: WorkspaceStatus; created_at: string; suspended_at: string | null;
  suspended_reason: string | null; bootstrap_owner_email: string; owner_acquired_at: string | null;
  members: { owner: number; admin: number; employee: number } | null;
  open_owner_invitation: { id: string; created_at: string; expires_at: string } | null;
  can_rotate_bootstrap: boolean;
};
type RawGrant = {
  id: string; workspace_id: string; workspace_name: string; workspace_status: WorkspaceStatus; admin_email: string | null;
  mode: "read" | "write"; reason: string; created_at: string; expires_at: string; revoked_at: string | null; active: boolean; mine: boolean;
};
type RawAudit = {
  id: number; created_at: string; action: string; reason: string | null; metadata: Record<string, unknown> | null;
  workspace_id: string | null; workspace_name: string | null; actor_email: string | null;
};

const summary = (r: RawSummary): WorkspaceSummary => ({
  id: r.id, name: r.name, slug: r.slug, status: r.status, createdAt: r.created_at,
  memberCount: Number(r.member_count), ownerJoined: r.owner_joined === true,
});

const detail = (r: RawDetail): WorkspaceDetail => ({
  id: r.id, name: r.name, slug: r.slug, status: r.status, createdAt: r.created_at,
  suspendedAt: r.suspended_at, suspendedReason: r.suspended_reason, bootstrapOwnerEmail: r.bootstrap_owner_email,
  ownerAcquiredAt: r.owner_acquired_at,
  members: { owner: Number(r.members?.owner ?? 0), admin: Number(r.members?.admin ?? 0), employee: Number(r.members?.employee ?? 0) },
  openOwnerInvitation: r.open_owner_invitation
    ? { id: r.open_owner_invitation.id, createdAt: r.open_owner_invitation.created_at, expiresAt: r.open_owner_invitation.expires_at }
    : null,
  canRotateBootstrap: r.can_rotate_bootstrap === true,
});

const grant = (r: RawGrant): AccessGrant => ({
  id: r.id, workspaceId: r.workspace_id, workspaceName: r.workspace_name, workspaceStatus: r.workspace_status,
  adminEmail: r.admin_email, mode: r.mode, reason: r.reason, createdAt: r.created_at, expiresAt: r.expires_at,
  revokedAt: r.revoked_at, active: r.active === true, mine: r.mine === true,
});

const SECRET_KEY = /token|hash|secret|password/i;

/** Audit metadata never carries credentials; keys that look like one are dropped regardless. */
export function safeMetadata(meta: Record<string, unknown> | null): Record<string, unknown> {
  return Object.fromEntries(Object.entries(meta ?? {}).filter(([k]) => !SECRET_KEY.test(k)));
}

const audit = (r: RawAudit): AuditEntry => ({
  id: Number(r.id), createdAt: r.created_at, action: r.action, reason: r.reason, metadata: safeMetadata(r.metadata),
  workspaceId: r.workspace_id, workspaceName: r.workspace_name, actorEmail: r.actor_email,
});

const workspaceCursor = z.strictObject({
  c: z.string().max(40).refine((v) => !Number.isNaN(Date.parse(v))),
  i: uuid,
});
const auditCursor = z.strictObject({ b: z.number().int().positive() });

export async function searchWorkspaces(
  { supabase }: PlatformScope,
  query: z.infer<typeof workspaceQuery>
): Promise<{ items: WorkspaceSummary[]; total: number; nextCursor: string | null }> {
  const after = decodeCursor(query.cursor, workspaceCursor);
  const data = check(await supabase.rpc("platform_search_workspaces", {
    p_query: query.q || null,
    p_status: query.status ?? null,
    p_limit: query.limit + 1,
    p_after_created: after?.c ?? null,
    p_after_id: after?.i ?? null,
  })) as { items: RawSummary[]; total: number };
  const rows = data.items ?? [];
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(summary),
    total: Number(data.total ?? 0),
    nextCursor: rows.length > query.limit && last ? encodeCursor({ c: last.created_at, i: last.id }) : null,
  };
}

export async function getWorkspace({ supabase }: PlatformScope, id: string): Promise<WorkspaceDetail> {
  return detail(check(await supabase.rpc("platform_get_workspace", { p_workspace_id: id })) as RawDetail);
}

export async function listGrants(
  { supabase }: PlatformScope,
  options: { workspaceId?: string; include: "active" | "all"; limit?: number }
): Promise<AccessGrant[]> {
  const rows = check(await supabase.rpc("platform_list_grants", {
    p_workspace_id: options.workspaceId ?? null,
    p_active_only: options.include === "active",
    p_limit: options.limit ?? 50,
  })) as RawGrant[] | null;
  return (rows ?? []).map(grant);
}

export async function auditPage(
  { supabase }: PlatformScope,
  workspaceId: string | null,
  query: z.infer<typeof auditQuery>
): Promise<{ items: AuditEntry[]; nextCursor: string | null }> {
  const before = decodeCursor(query.cursor, auditCursor);
  const rows = (check(await supabase.rpc("platform_audit_page", {
    p_workspace_id: workspaceId,
    p_before_id: before?.b ?? null,
    p_limit: query.limit + 1,
  })) as RawAudit[] | null) ?? [];
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(audit),
    nextCursor: rows.length > query.limit && last ? encodeCursor({ b: Number(last.id) }) : null,
  };
}

const inviteLink = (origin: string, token: string) => `${origin}/invite/${token}`;

/**
 * §5.3: transactional and idempotent. A new workspace returns its owner invitation link once; a
 * repeat with the same inputs returns the same workspace and no link (tokens are never stored or
 * re-issued here — use rotateBootstrapInvitation). Different inputs for the same key are 409.
 */
export async function provisionWorkspace(
  { supabase }: PlatformScope,
  input: z.infer<typeof provisionBody>,
  origin: string
): Promise<{ workspaceId: string; inviteUrl: string | null; created: boolean }> {
  const data = check(await supabase.rpc("platform_provision_workspace", {
    p_provisioning_key: input.provisioningKey,
    p_name: input.name,
    p_slug: input.slug,
    p_owner_email: input.ownerEmail,
  })) as { workspace_id: string; created: boolean; invite_token: string | null };
  return {
    workspaceId: data.workspace_id,
    created: data.created === true,
    inviteUrl: data.created && data.invite_token ? inviteLink(origin, data.invite_token) : null,
  };
}

export async function suspendWorkspace(scope: PlatformScope, id: string, why: string): Promise<WorkspaceDetail> {
  check(await scope.supabase.rpc("platform_suspend_workspace", { p_workspace_id: id, p_reason: why }));
  return getWorkspace(scope, id);
}

export async function reactivateWorkspace(scope: PlatformScope, id: string, why: string): Promise<WorkspaceDetail> {
  check(await scope.supabase.rpc("platform_reactivate_workspace", { p_workspace_id: id, p_reason: why }));
  return getWorkspace(scope, id);
}

/** Replaces a lost or expired bootstrap owner invitation; the new link is returned once. */
export async function rotateBootstrapInvitation(
  { supabase }: PlatformScope,
  id: string,
  why: string,
  origin: string
): Promise<{ inviteUrl: string; expiresAt: string; revokedInvitations: number }> {
  const data = check(await supabase.rpc("platform_rotate_bootstrap_invitation", { p_workspace_id: id, p_reason: why })) as {
    invite_token: string; expires_at: string; revoked_invitation_ids: string[] | null;
  };
  return { inviteUrl: inviteLink(origin, data.invite_token), expiresAt: data.expires_at, revokedInvitations: (data.revoked_invitation_ids ?? []).length };
}

/** Time-limited, audited access; the admin's active workspace becomes this one. */
export async function grantAccess(
  { supabase }: PlatformScope,
  id: string,
  input: z.infer<typeof accessBody>
): Promise<{ id: string; workspaceId: string; mode: "read" | "write"; expiresAt: string }> {
  const data = check(await supabase.rpc("platform_grant_access", {
    p_workspace_id: id,
    p_mode: input.mode,
    p_reason: input.reason,
    p_minutes: input.durationMinutes,
  })) as { id: string; workspace_id: string; mode: "read" | "write"; expires_at: string };
  return { id: data.id, workspaceId: data.workspace_id, mode: data.mode, expiresAt: data.expires_at };
}

export async function revokeGrant({ supabase }: PlatformScope, grantId: string, why: string): Promise<void> {
  check(await supabase.rpc("platform_revoke_access", { p_grant_id: grantId, p_reason: why }));
}
