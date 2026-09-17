import { AppShell } from "@/components/AppShell";
import emails from "@/content/emails.json";
import sms from "@/content/sms.json";
import snippets from "@/content/snippets.json";
import alerts from "@/content/alerts.json";
import { applyClientBusinessName } from "@/lib/mapping";
import { clientBusinessName } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export default function LibraryPage() {
  const biz = clientBusinessName();
  const resolvedSnippets = snippets.map((s) => ({
    ...s,
    body: applyClientBusinessName(s.body, biz),
  }));

  return (
    <AppShell>
      <h1>Content library</h1>
      <p className="muted">
        Local drafts for <strong>{biz}</strong>. Nothing here sends. Copy uses the configured
        client business name where marked.
      </p>
      <article className="card">
        <h2>Email templates ({emails.length})</h2>
        {emails.map((e) => (
          <section key={e.id}>
            <h3>
              {e.id} — {e.name}
            </h3>
            <p className="muted">Subject: {e.subject}</p>
            <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{e.body}</pre>
          </section>
        ))}
      </article>
      <article className="card" style={{ marginTop: "1rem" }}>
        <h2>SMS bodies ({sms.length})</h2>
        {sms.map((s) => (
          <p key={s.id}>
            <strong>{s.id}</strong> — {s.text}
          </p>
        ))}
      </article>
      <article className="card" style={{ marginTop: "1rem" }}>
        <h2>Internal alerts ({alerts.length}) — recovered, activation OFF</h2>
        {alerts.map((a) => (
          <section key={a.id}>
            <h3>
              {a.id} — {a.name}
            </h3>
            <p className="muted">
              Trigger: {a.trigger} · Next: {a.next} · {a.channel}
            </p>
            <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{a.body}</pre>
          </section>
        ))}
      </article>
      <article className="card" style={{ marginTop: "1rem" }}>
        <h2>Conversation snippets ({resolvedSnippets.length})</h2>
        {resolvedSnippets.map((s) => (
          <p key={s.id}>
            <strong>{s.title}</strong> — {s.body}
          </p>
        ))}
      </article>
    </AppShell>
  );
}
