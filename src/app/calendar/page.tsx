import { AppShell } from "@/components/AppShell";
import { StatusBanner } from "@/components/Chrome";
import { Card, PageHead, EmptyState } from "@/components/ui";

const CALENDARS = [
  { name: "Discovery Call", duration: "30 min" },
  { name: "Website Consultation", duration: "30 min" },
  { name: "Business Consultation", duration: "30 min" },
  { name: "Client / Project Meeting", duration: "30 min" },
  { name: "Core Booking", duration: "1 hr" },
];

export default function CalendarPage() {
  return (
    <AppShell>
      <PageHead
        title="Calendars"
        description="Real bookings only. A website form's preferred time is a request, not a reserved slot."
      />

      <StatusBanner>
        Host / staff assignment for these calendars is still pending owner confirmation — nothing
        shown here is a live booking.
      </StatusBanner>

      <div className="grid grid-3" style={{ marginTop: "1.1rem" }}>
        {CALENDARS.map((cal) => (
          <Card key={cal.name} title={cal.name}>
            <p className="muted" style={{ marginTop: 0 }}>
              Duration: {cal.duration}
            </p>
            <EmptyState
              title="No appointments scheduled"
              note="Bookings will appear here once this calendar is connected."
            />
          </Card>
        ))}
      </div>
    </AppShell>
  );
}
