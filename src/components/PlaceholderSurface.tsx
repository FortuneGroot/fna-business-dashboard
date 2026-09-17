import { AppShell } from "@/components/AppShell";
import { StatusBanner } from "@/components/Chrome";
import Link from "next/link";

export function PlaceholderSurface({
  title,
  purpose,
  later,
}: {
  title: string;
  purpose: string;
  later: string;
}) {
  return (
    <AppShell>
      <h1>{title}</h1>
      <p>{purpose}</p>
      <StatusBanner>
        This area is recovered from client training / white-label specs. It is a shell only — live
        customer data is not connected here.
      </StatusBanner>
      <div className="empty">{later}</div>
      <p>
        <Link href="/dashboard">Back to dashboard</Link>
      </p>
    </AppShell>
  );
}
