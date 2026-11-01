import { AppShell } from "@/components/AppShell";
import { Card, Badge, PageHead } from "@/components/ui";
import { requirePageRole } from "@/lib/auth/guards";
import {
  evaluateClientReadiness,
  toPublicReadinessPayload,
} from "@/lib/onboarding";
import { getTenantConfig } from "@/lib/tenant";
import { getPageData, getPageScope } from "@/lib/data";
import type { ChecklistItem, ChecklistKey } from "@/lib/native/onboarding";

export const dynamic = "force-dynamic";

type ReadinessView = {
  status?: string;
  checks?: { id?: string; label?: string; detail?: string; status?: string }[];
};

const NATIVE_STEPS: Record<ChecklistKey, { label: string; detail: string }> = {
  profile: {
    label: "Complete the business profile",
    detail: "Add a support email or business phone in Settings so customers know how to reach you.",
  },
  team: {
    label: "Invite your team",
    detail: "Create an invite link in Settings → Team / Staff and share it yourself — nothing is emailed.",
  },
  calendar: {
    label: "Create a calendar",
    detail: "Add a calendar so appointments can be booked and confirmed by your team.",
  },
  ai_config: {
    label: "Prepare the AI receptionist",
    detail: "Write a greeting in Settings. The receptionist stays off until its runtime is available.",
  },
};

/** Native workspaces: the §7.4 checklist (GET /api/onboarding/checklist) computed from the workspace's own records. */
function nativeReadiness(items: ChecklistItem[]): ReadinessView {
  const checks = items.map((item) => ({
    id: item.key,
    label: NATIVE_STEPS[item.key].label,
    detail: NATIVE_STEPS[item.key].detail,
    status: item.done ? "pass" : "pending",
  }));
  return { status: checks.every((c) => c.status === "pass") ? "READY" : "IN PROGRESS", checks };
}

async function nativeChecklist(): Promise<ChecklistItem[]> {
  const { onboardingChecklist } = await import("@/lib/native/onboarding");
  return onboardingChecklist(await getPageScope());
}

const FALLBACK_STEPS = [
  {
    title: "Connect your calendar",
    description:
      "Link a calendar so appointment requests can be reviewed and confirmed by your team.",
  },
  {
    title: "Add your first contact",
    description:
      "Bring in a real contact once the CRM connection is live — no sample data is seeded here.",
  },
  {
    title: "Set up automations",
    description:
      "Follow-up and reminder workflows turn on only after an owner explicitly approves them.",
  },
  {
    title: "Connect payments",
    description:
      "Invoicing and payment collection become available once a payment processor is connected.",
  },
];

export default async function OnboardingPage() {
  await requirePageRole("OWNER", "onboarding.read");
  const data = await getPageData();
  const { native } = data;
  const summary = await data.reader.summary();
  const publicReport: ReadinessView = native
    ? nativeReadiness(await nativeChecklist())
    : toPublicReadinessPayload(evaluateClientReadiness(getTenantConfig()));

  const checks = publicReport.checks?.length
    ? publicReport.checks.map((c) => {
        const passed = c.status === "pass";
        return {
          title: c.label || c.id || "Check",
          description: c.detail || "",
          passed,
          tone: passed ? ("ok" as const) : c.status === "blocked" ? ("danger" as const) : ("neutral" as const),
          badge: passed ? "Ready" : c.status === "partial" ? "Partial" : "Pending",
        };
      })
    : FALLBACK_STEPS.map((s) => ({
        ...s,
        passed: false,
        tone: "neutral" as const,
        badge: "Pending",
      }));

  return (
    <AppShell>
      <PageHead
        title="Onboarding / Setup Checklist"
        description={
          native
            ? "Owner-only setup status for this workspace. Nothing is marked done until it is genuinely set up."
            : "Owner-only setup status from your configuration and sync activity. Nothing is marked done until it is genuinely connected."
        }
      />

      <Card
        title="Configuration readiness"
        action={
          <Badge tone={publicReport.status === "READY" ? "ok" : "warn"}>
            {publicReport.status || "UNKNOWN"}
          </Badge>
        }
      >
        {native ? (
          <p className="muted" style={{ marginTop: 0 }}>
            Workspace records: {summary.waitingForSync ? "none yet" : "added"}. Last activity:{" "}
            {summary.lastEventAt ? summary.lastEventAt.slice(0, 19).replace("T", " ") : "none yet"}.
          </p>
        ) : (
          <p className="muted" style={{ marginTop: 0 }}>
            Sync waiting: {summary.waitingForSync ? "yes — no events yet" : "no — events received"}.
            Last sync event:{" "}
            {summary.lastEventAt
              ? summary.lastEventAt.slice(0, 19).replace("T", " ")
              : "none yet"}
            .
          </p>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
          {checks.map((s, i) => (
            <div
              key={`${s.title}-${i}`}
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: "1rem",
                padding: "0.9rem 0",
                borderBottom: i < checks.length - 1 ? "1px solid var(--line)" : undefined,
              }}
            >
              <div>
                <strong>
                  {i + 1}. {s.title}
                </strong>
                {s.description ? (
                  <p className="muted" style={{ margin: "0.25rem 0 0" }}>
                    {s.description}
                  </p>
                ) : null}
              </div>
              <Badge tone={s.tone}>{s.badge}</Badge>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid grid-2" style={{ marginTop: "1.1rem" }}>
        <Card title="Tell us what you need">
          <p>
            Submit a request about Automation, Websites, Branding, or Systems — or book a
            conversation if a time is available.
          </p>
        </Card>
        <Card title="Ask for a person anytime">
          <p>
            If you want a human, say so. Conversation AI stays off until an owner explicitly
            approves it.
          </p>
        </Card>
      </div>
    </AppShell>
  );
}
