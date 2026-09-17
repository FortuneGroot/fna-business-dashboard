import { AppShell } from "@/components/AppShell";
import { PageHead } from "@/components/ui";
import { BRAND } from "@/lib/brand";

export default function TermsPage() {
  return (
    <AppShell>
      <PageHead title="Terms of Use" description="Draft terms for the branded shell. Not a substitute for legal review." />
      <article className="card">
        <h2>About this preview</h2>
        <p>
          This preview of the {BRAND.product} is provided so staff can review branding and
          navigation. Features labeled as placeholders are not live services.
        </p>
        <h2>Requests are not contracts</h2>
        <p>
          A submitted request is not a contract, reserved appointment, or confirmed price. Scope and
          availability are confirmed by the team.
        </p>
        <h2>Legal entity</h2>
        <p>
          Legal entity: {BRAND.legal}. Intended app host: {BRAND.appHost}.
        </p>
        <p className="muted">This policy will be finalized before public launch.</p>
      </article>
    </AppShell>
  );
}
