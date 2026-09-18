import { AppShell } from "@/components/AppShell";
import { PageHead, Card } from "@/components/ui";
import emails from "@/content/emails.json";
import sms from "@/content/sms.json";
import snippets from "@/content/snippets.json";
import alerts from "@/content/alerts.json";
import { applyClientBusinessName } from "@/lib/mapping";
import { clientBusinessName } from "@/lib/tenant";
import { sanitizeClientFacingCopy } from "@/lib/ui/sync-copy";

export const dynamic = "force-dynamic";

export default function LibraryPage() {
  const biz = clientBusinessName();
  const resolvedSnippets = snippets.map((s) => ({
    ...s,
    body: sanitizeClientFacingCopy(applyClientBusinessName(s.body, biz)),
  }));
  const resolvedEmails = emails.map((e) => ({
    ...e,
    subject: sanitizeClientFacingCopy(e.subject),
    body: sanitizeClientFacingCopy(e.body),
  }));
  const resolvedSms = sms.map((s) => ({
    ...s,
    text: sanitizeClientFacingCopy(s.text),
  }));
  const resolvedAlerts = alerts.map((a) => ({
    ...a,
    body: sanitizeClientFacingCopy(a.body),
  }));

  return (
    <AppShell>
      <PageHead
        title="Resources"
        description={`Draft messages for ${biz}. Nothing here sends automatically.`}
      />

      <Card title={`Email drafts (${resolvedEmails.length})`}>
        {resolvedEmails.map((e) => (
          <section key={e.id} style={{ marginBottom: "1.1rem" }}>
            <h3 style={{ marginBottom: "0.25rem" }}>{e.name}</h3>
            <p className="muted" style={{ marginTop: 0 }}>
              Subject: {e.subject}
            </p>
            <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{e.body}</pre>
          </section>
        ))}
      </Card>

      <div style={{ marginTop: "1rem" }}>
        <Card title={`Text drafts (${resolvedSms.length})`}>
          {resolvedSms.map((s) => (
            <p key={s.id}>{s.text}</p>
          ))}
        </Card>
      </div>

      <div style={{ marginTop: "1rem" }}>
        <Card title={`Internal alerts (${resolvedAlerts.length})`}>
          <p className="muted" style={{ marginTop: 0 }}>
            These drafts are inactive until Fortune & Automations turns them on with you.
          </p>
          {resolvedAlerts.map((a) => (
            <section key={a.id} style={{ marginBottom: "1rem" }}>
              <h3 style={{ marginBottom: "0.25rem" }}>{a.name}</h3>
              <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{a.body}</pre>
            </section>
          ))}
        </Card>
      </div>

      <div style={{ marginTop: "1rem" }}>
        <Card title={`Conversation snippets (${resolvedSnippets.length})`}>
          {resolvedSnippets.map((s) => (
            <p key={s.id}>
              <strong>{s.title}</strong> — {s.body}
            </p>
          ))}
        </Card>
      </div>
    </AppShell>
  );
}
