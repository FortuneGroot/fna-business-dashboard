"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { Badge, Card, DataTable, EmptyState, Modal } from "@/components/ui";
import { api, failure } from "@/lib/ui/native-api";

/* Native-workspace Settings sections (AUTH_PROVIDER=supabase). They reuse the page's existing
 * cards, form controls and table; every change goes through the §7.4 APIs with the user's session. */

type Role = "owner" | "admin" | "employee";
const ROLE_LABEL: Record<Role, string> = { owner: "Owner", admin: "Admin", employee: "Employee" };

function when(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : "—";
}

// ---------------------------------------------------------------------------
// Business profile
// ---------------------------------------------------------------------------

type Settings = {
  businessName: string;
  timezone: string;
  supportEmail: string | null;
  businessPhone: string | null;
  websiteUrl: string | null;
  bookingUrl: string | null;
  reviewUrl: string | null;
  businessHours: Record<string, { start: string; end: string }[]>;
};

const PROFILE_FIELDS = [
  ["supportEmail", "Support email", "email"],
  ["businessPhone", "Business phone", "tel"],
  ["websiteUrl", "Website", "url"],
  ["bookingUrl", "Booking link", "url"],
  ["reviewUrl", "Review link", "url"],
] as const;

function hoursSummary(hours: Settings["businessHours"]): string {
  const days = Object.entries(hours).filter(([, v]) => v.length);
  if (!days.length) return "";
  return days.map(([d, v]) => `${d[0].toUpperCase()}${d.slice(1)} ${v.map((i) => `${i.start}–${i.end}`).join(", ")}`).join(" · ");
}

export function NativeBusinessProfile({ canEdit }: { canEdit: boolean }) {
  const [form, setForm] = useState<Settings | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api("/api/settings/workspace").then(({ body }) => {
      if (body.ok) setForm(body.settings as Settings);
      else setMessage({ tone: "error", text: failure(body, "Could not load the business profile.") });
    });
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setMessage(null);
    const blank = (v: string | null) => (v && v.trim() ? v.trim() : null);
    const { status, body } = await api("/api/settings/workspace", {
      method: "PATCH",
      body: JSON.stringify({
        businessName: form.businessName,
        timezone: form.timezone,
        supportEmail: blank(form.supportEmail),
        businessPhone: blank(form.businessPhone),
        websiteUrl: blank(form.websiteUrl),
        bookingUrl: blank(form.bookingUrl),
        reviewUrl: blank(form.reviewUrl),
      }),
    });
    setBusy(false);
    if (status === 200 && body.ok) {
      setForm(body.settings as Settings);
      setMessage({ tone: "ok", text: "Business profile saved." });
    } else {
      setMessage({ tone: "error", text: failure(body, "Could not save the business profile.") });
    }
  }

  const set = (key: keyof Settings) => (e: { target: { value: string } }) =>
    setForm((f) => (f ? { ...f, [key]: e.target.value } : f));
  const disabled = !canEdit || !form || busy;

  return (
    <Card title="Business Profile">
      <form onSubmit={save} aria-label="Business profile">
        {message ? (
          <div className={`banner ${message.tone === "error" ? "error" : "gold"}`} role={message.tone === "error" ? "alert" : "status"}>
            {message.text}
          </div>
        ) : null}
        <label htmlFor="biz-name">Business name</label>
        <input id="biz-name" value={form?.businessName ?? ""} onChange={set("businessName")} disabled={disabled} required maxLength={120} />
        <label htmlFor="biz-tz">Timezone</label>
        <input id="biz-tz" value={form?.timezone ?? ""} onChange={set("timezone")} disabled={disabled} required maxLength={64} />
        <label htmlFor="biz-hours">Business hours</label>
        <input
          id="biz-hours"
          value={form ? hoursSummary(form.businessHours) : ""}
          placeholder="Not set yet"
          disabled
          aria-disabled="true"
          title="Editing business hours is not available yet"
          readOnly
        />
        {PROFILE_FIELDS.map(([key, label, type]) => (
          <div key={key}>
            <label htmlFor={`biz-${key}`}>{label}</label>
            <input
              id={`biz-${key}`}
              type={type}
              value={(form?.[key] as string | null) ?? ""}
              onChange={set(key)}
              disabled={disabled}
              placeholder="Not set yet"
            />
          </div>
        ))}
        {canEdit ? (
          <button className="btn" type="submit" disabled={disabled} style={{ marginTop: "1rem" }}>
            {busy ? "Saving…" : "Save profile"}
          </button>
        ) : (
          <p className="muted" style={{ marginTop: "0.6rem" }}>
            Profile details are managed by your workspace owner.
          </p>
        )}
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

type Integration = { provider: string; status: "disconnected" | "connected" | "error"; verifiedAt: string | null };

export function NativeIntegrations({ pipelineName, stagesCount }: { pipelineName?: string; stagesCount?: number }) {
  const [items, setItems] = useState<Integration[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void api("/api/integrations").then(({ body }) => {
      if (body.ok) setItems(body.items as Integration[]);
      else setError(failure(body, "Could not load integrations."));
    });
  }, []);

  const connected = (items ?? []).filter((i) => i.status === "connected").length;
  return (
    <Card
      title="Integrations"
      action={<Badge tone={connected ? "ok" : "neutral"}>{items === null ? "Checking…" : connected ? `${connected} connected` : "Not connected"}</Badge>}
    >
      {error ? <div className="banner error" role="alert">{error}</div> : null}
      {items && items.length ? (
        <DataTable
          columns={["Provider", "Status", "Verified"]}
          rows={items.map((i) => [
            i.provider,
            <Badge key="s" tone={i.status === "connected" ? "ok" : i.status === "error" ? "danger" : "neutral"}>{i.status}</Badge>,
            when(i.verifiedAt),
          ])}
        />
      ) : items ? (
        <p>No integrations are connected to this workspace yet.</p>
      ) : null}
      {pipelineName ? (
        <p className="muted">
          Pipeline: {pipelineName}
          {stagesCount ? ` · ${stagesCount} stages` : ""}
        </p>
      ) : null}
      <p className="muted">Connections are verified by Fortune &amp; Automations. Credentials are never shown here.</p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Team / Staff
// ---------------------------------------------------------------------------

export type TeamMember = { userId: string; name: string; email: string; role: Role; joinedAt: string };
type Invitation = { id: string; email: string; role: Role; expiresAt: string; status: string };

export function useTeam(enabled: boolean) {
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    if (!enabled) return;
    const { body } = await api("/api/team");
    if (body.ok) setMembers(body.members as TeamMember[]);
    else setError(failure(body, "Could not load the team."));
  }, [enabled]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { members, error, reload };
}

export function NativeTeam({
  permissions,
  myUserId,
  team,
}: {
  permissions: string[];
  myUserId: string | null;
  team: ReturnType<typeof useTeam>;
}) {
  const can = (p: string) => permissions.includes(p);
  const invitable = (["employee", "admin", "owner"] as Role[]).filter((r) => can(`team.invite_${r}`));
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [inviteUrl, setInviteUrl] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>(invitable[0] ?? "employee");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<TeamMember | null>(null);

  const loadInvites = useCallback(async () => {
    const { body } = await api("/api/team/invitations");
    if (body.ok) setInvites((body.items as Invitation[]).filter((i) => i.status === "pending"));
  }, []);

  useEffect(() => {
    void loadInvites();
  }, [loadInvites]);

  async function invite(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    setInviteUrl("");
    const { body } = await api("/api/team/invitations", { method: "POST", body: JSON.stringify({ email, role }) });
    setBusy(false);
    if (body.ok) {
      setInviteUrl(String(body.inviteUrl));
      setEmail("");
      void loadInvites();
    } else {
      setMessage({ tone: "error", text: failure(body, "Could not create the invitation.") });
    }
  }

  async function revoke(id: string) {
    setMessage(null);
    const { body } = await api(`/api/team/invitations/${id}`, { method: "DELETE" });
    if (body.ok) {
      setMessage({ tone: "ok", text: "Invitation revoked." });
      void loadInvites();
    } else setMessage({ tone: "error", text: failure(body, "Could not revoke the invitation.") });
  }

  async function changeRole(member: TeamMember, next: Role) {
    setMessage(null);
    const { body } = await api(`/api/team/${member.userId}`, { method: "PATCH", body: JSON.stringify({ role: next }) });
    if (body.ok) setMessage({ tone: "ok", text: `${member.name || member.email} is now ${ROLE_LABEL[next]}.` });
    else setMessage({ tone: "error", text: failure(body, "Could not change the role.") });
    void team.reload();
  }

  async function confirmRemove() {
    if (!removing) return;
    const member = removing;
    setRemoving(null);
    setMessage(null);
    const { body } = await api(`/api/team/${member.userId}`, { method: "DELETE" });
    if (body.ok) setMessage({ tone: "ok", text: `${member.name || member.email} was removed from the workspace.` });
    else setMessage({ tone: "error", text: failure(body, "Could not remove the member.") });
    void team.reload();
  }

  const canRemove = (m: TeamMember) =>
    m.userId !== myUserId && (m.role === "employee" ? can("team.remove") : can("team.change_role"));

  return (
    <Card title="Team / Staff" action={team.members ? <Badge tone="neutral">{team.members.length} active</Badge> : undefined}>
      {message ? (
        <div className={`banner ${message.tone === "error" ? "error" : "gold"}`} role={message.tone === "error" ? "alert" : "status"}>
          {message.text}
        </div>
      ) : null}
      {team.error ? <div className="banner error" role="alert">{team.error}</div> : null}
      {team.members ? (
        <DataTable
          columns={["Name", "Email", "Role", ""]}
          emptyTitle="No team members yet"
          rows={team.members.map((m) => [
            m.name || "—",
            m.email,
            can("team.change_role") && m.userId !== myUserId ? (
              <select
                key="role"
                aria-label={`Role for ${m.email}`}
                value={m.role}
                onChange={(e) => void changeRole(m, e.target.value as Role)}
              >
                {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
                  <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                ))}
              </select>
            ) : (
              <span key="role">{ROLE_LABEL[m.role]}{m.userId === myUserId ? " (you)" : ""}</span>
            ),
            canRemove(m) ? (
              <button key="rm" type="button" className="btn secondary sm" onClick={() => setRemoving(m)} aria-label={`Remove ${m.email}`}>
                Remove
              </button>
            ) : (
              ""
            ),
          ])}
        />
      ) : (
        <p className="muted">Loading team…</p>
      )}

      {invitable.length ? (
        <form onSubmit={invite} aria-label="Invite a team member" style={{ marginTop: "1rem" }}>
          <label htmlFor="invite-email">Invite by email</label>
          <input id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={254} />
          <label htmlFor="invite-role">Role</label>
          <select id="invite-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {invitable.map((r) => (
              <option key={r} value={r}>{ROLE_LABEL[r]}</option>
            ))}
          </select>
          <button className="btn" type="submit" disabled={busy} style={{ marginTop: "1rem" }}>
            {busy ? "Creating…" : "Create invite link"}
          </button>
        </form>
      ) : null}

      {inviteUrl ? (
        <div className="banner gold" role="status" style={{ marginTop: "1rem" }}>
          <strong>Invite link (shown once).</strong> Share it with the invitee yourself — no email or text message is sent.
          <input aria-label="Invite link" value={inviteUrl} readOnly onFocus={(e) => e.target.select()} style={{ marginTop: "0.5rem" }} />
          <button type="button" className="btn secondary sm" style={{ marginTop: "0.5rem" }} onClick={() => void navigator.clipboard?.writeText(inviteUrl)}>
            Copy link
          </button>
        </div>
      ) : null}

      {invites.length ? (
        <div style={{ marginTop: "1rem" }}>
          <p className="muted" style={{ marginBottom: "0.4rem" }}>Pending invitations</p>
          <DataTable
            columns={["Email", "Role", "Expires", ""]}
            rows={invites.map((i) => [
              i.email,
              ROLE_LABEL[i.role],
              when(i.expiresAt),
              can(`team.invite_${i.role}`) ? (
                <button key="rv" type="button" className="btn secondary sm" onClick={() => void revoke(i.id)} aria-label={`Revoke invitation for ${i.email}`}>
                  Revoke
                </button>
              ) : (
                ""
              ),
            ])}
          />
        </div>
      ) : null}

      <Modal open={Boolean(removing)} onClose={() => setRemoving(null)} title="Remove team member">
        <p>
          Remove {removing?.name || removing?.email} from this workspace? They lose access immediately and are unassigned
          from open work.
        </p>
        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
          <button type="button" className="btn secondary" onClick={() => setRemoving(null)}>Cancel</button>
          <button type="button" className="btn" onClick={() => void confirmRemove()}>Remove</button>
        </div>
      </Modal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// AI receptionist (configuration only)
// ---------------------------------------------------------------------------

type AiConfig = {
  greeting: string;
  businessHoursMode: "always" | "business_hours" | "off";
  escalationUserId: string | null;
};

const HOURS_MODE: Record<AiConfig["businessHoursMode"], string> = {
  business_hours: "During business hours",
  always: "Always",
  off: "Off",
};

export function NativeAiReceptionist({ canEdit, members }: { canEdit: boolean; members: TeamMember[] | null }) {
  const [form, setForm] = useState<AiConfig | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api("/api/settings/ai-receptionist").then(({ body }) => {
      if (body.ok) setForm(body.config as AiConfig);
      else setMessage({ tone: "error", text: failure(body, "Could not load the AI receptionist settings.") });
    });
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setMessage(null);
    const { body } = await api("/api/settings/ai-receptionist", {
      method: "PUT",
      body: JSON.stringify({
        greeting: form.greeting,
        businessHoursMode: form.businessHoursMode,
        escalationUserId: form.escalationUserId || null,
      }),
    });
    setBusy(false);
    if (body.ok) {
      setForm(body.config as AiConfig);
      setMessage({ tone: "ok", text: "AI receptionist settings saved. It stays off." });
    } else setMessage({ tone: "error", text: failure(body, "Could not save the AI receptionist settings.") });
  }

  const disabled = !canEdit || !form || busy;
  return (
    <Card title="AI Receptionist" action={<Badge tone="neutral">Off</Badge>}>
      <p className="muted" style={{ marginTop: 0 }}>
        The AI receptionist stays off until its runtime is available. You can prepare its settings now; no calls or
        messages are handled.
      </p>
      <form onSubmit={save} aria-label="AI receptionist settings">
        {message ? (
          <div className={`banner ${message.tone === "error" ? "error" : "gold"}`} role={message.tone === "error" ? "alert" : "status"}>
            {message.text}
          </div>
        ) : null}
        <label htmlFor="ai-greeting">Greeting</label>
        <textarea
          id="ai-greeting"
          value={form?.greeting ?? ""}
          maxLength={2000}
          onChange={(e) => setForm((f) => (f ? { ...f, greeting: e.target.value } : f))}
          disabled={disabled}
          placeholder="Not set yet"
        />
        <label htmlFor="ai-hours">Answer calls</label>
        <select
          id="ai-hours"
          value={form?.businessHoursMode ?? "business_hours"}
          onChange={(e) => setForm((f) => (f ? { ...f, businessHoursMode: e.target.value as AiConfig["businessHoursMode"] } : f))}
          disabled={disabled}
        >
          {Object.entries(HOURS_MODE).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
        <label htmlFor="ai-escalation">Escalate to</label>
        <select
          id="ai-escalation"
          value={form?.escalationUserId ?? ""}
          onChange={(e) => setForm((f) => (f ? { ...f, escalationUserId: e.target.value || null } : f))}
          disabled={disabled}
        >
          <option value="">Nobody yet</option>
          {(members ?? []).map((m) => (
            <option key={m.userId} value={m.userId}>{m.name || m.email}</option>
          ))}
        </select>
        {canEdit ? (
          <button className="btn" type="submit" disabled={disabled} style={{ marginTop: "1rem" }}>
            {busy ? "Saving…" : "Save AI settings"}
          </button>
        ) : null}
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Recent changes (workspace audit log)
// ---------------------------------------------------------------------------

type AuditItem = { id: number; action: string; actorName: string | null; actorKind: string; createdAt: string };

const ACTION_LABEL: Record<string, string> = {
  "invitation.created": "Invitation created",
  "invitation.accepted": "Invitation accepted",
  "invitation.revoked": "Invitation revoked",
  "member.role_changed": "Role changed",
  "member.permission_override": "Permission changed",
  "member.removed": "Member removed",
  "member.left": "Member left",
  "settings.updated": "Business profile updated",
  "ai_receptionist.updated": "AI receptionist settings updated",
  "integration.updated": "Integration updated",
};

export function NativeAudit() {
  const [items, setItems] = useState<AuditItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async (after: string | null) => {
    const { body } = await api(`/api/audit?limit=10${after ? `&cursor=${encodeURIComponent(after)}` : ""}`);
    if (!body.ok) {
      setError(failure(body, "Could not load recent changes."));
      return;
    }
    setItems((prev) => [...(after && prev ? prev : []), ...(body.items as AuditItem[])]);
    setCursor((body.nextCursor as string | null) ?? null);
  }, []);

  useEffect(() => {
    void load(null);
  }, [load]);

  return (
    <Card title="Recent changes">
      {error ? <div className="banner error" role="alert">{error}</div> : null}
      {items && !items.length ? <EmptyState title="No changes recorded yet" note="Team and settings changes will appear here." /> : null}
      {items && items.length ? (
        <DataTable
          columns={["When", "Change", "By"]}
          rows={items.map((i) => [
            when(i.createdAt),
            ACTION_LABEL[i.action] ?? i.action,
            i.actorName ?? (i.actorKind === "platform_admin" ? "Fortune & Automations" : i.actorKind === "system" ? "System" : "—"),
          ])}
        />
      ) : null}
      {cursor ? (
        <button type="button" className="btn secondary sm" style={{ marginTop: "0.75rem" }} onClick={() => void load(cursor)}>
          Show more
        </button>
      ) : null}
    </Card>
  );
}
