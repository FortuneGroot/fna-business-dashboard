import { AppShell } from "@/components/AppShell";
import emails from "@/content/emails.json";
import sms from "@/content/sms.json";
import snippets from "@/content/snippets.json";
import alerts from "@/content/alerts.json";

export default function LibraryPage() {
  return (
    <AppShell>
      <h1>Content library</h1>
      <p className="muted">Local drafts only. Nothing here sends. Copy is ready to use once messaging is connected.</p>
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
        <h2>Conversation snippets ({snippets.length})</h2>
        {snippets.map((s) => (
          <p key={s.id}>
            <strong>{s.title}</strong> — {s.body}
          </p>
        ))}
      </article>
    </AppShell>
  );
}
