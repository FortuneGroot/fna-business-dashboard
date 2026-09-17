import { AppShell } from "@/components/AppShell";
import { PageHead } from "@/components/ui";
import { BRAND } from "@/lib/brand";

export default function PrivacyPage() {
  return (
    <AppShell>
      <PageHead title="Privacy Policy" description="Draft notice for the branded shell. Not a substitute for legal review." />
      <article className="card">
        <h2>What we collect</h2>
        <p>
          {BRAND.legal}, doing business as {BRAND.name}, collects inquiry information you submit
          through forms so the team can review your request.
        </p>
        <h2>Consent — texts and email</h2>
        <p>
          We do not treat a phone number or email as marketing consent unless you check an
          independent opt-in box. Reply STOP to opt out of texts at any time.
        </p>
        <h2>Data handling in this shell</h2>
        <p>
          This application shell does not currently write to production CRM records. Dry-run
          submissions are logged locally/on the server and are intended for fake test contacts only.
        </p>
        <h2>Contact</h2>
        <p>
          Questions: use the Support page. Do not send emergency requests through this site.
          <br />
          Legal entity: {BRAND.legal} · {BRAND.website}
        </p>
        <p className="muted">This policy will be finalized before public launch.</p>
      </article>
    </AppShell>
  );
}
