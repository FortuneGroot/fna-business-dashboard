import { AppShell } from "@/components/AppShell";
import { StatusBanner } from "@/components/Chrome";
import { Card, PageHead, EmptyState } from "@/components/ui";
import { WaitingForSync } from "@/components/WaitingForSync";
import { getSyncStore } from "@/lib/sync";

export const dynamic = "force-dynamic";

const CALENDARS = [
  { name: "Discovery Call", duration: "30 min" },
  { name: "Website Consultation", duration: "30 min" },
  { name: "Business Consultation", duration: "30 min" },
  { name: "Client / Project Meeting", duration: "30 min" },
  { name: "Core Booking", duration: "1 hr" },
];

export default function CalendarPage() {
  const appointments = getSyncStore().listAppointments();
  const waiting = appointments.length === 0;

  return (
    <AppShell>
      <PageHead
        title="Calendars"
        description="Bookings synced from HighLevel appointment workflows. A website form preferred time is still a request, not a reserved slot."
      />

      <StatusBanner>
        {waiting
          ? "Waiting for HighLevel sync — no appointments received yet."
          : `${appointments.length} appointment(s) synced from webhooks.`}
      </StatusBanner>

      <div className="grid grid-3" style={{ marginTop: "1.1rem" }}>
        {CALENDARS.map((cal) => {
          const items = appointments.filter(
            (a) =>
              !a.calendarName ||
              a.calendarName.toLowerCase() === cal.name.toLowerCase() ||
              a.calendarName.toLowerCase().includes(cal.name.toLowerCase().split(" ")[0])
          );
          const show = waiting ? [] : items.length ? items : appointments;
          return (
            <Card key={cal.name} title={cal.name}>
              <p className="muted" style={{ marginTop: 0 }}>
                Duration: {cal.duration}
              </p>
              {waiting ? (
                <WaitingForSync entity="appointments" />
              ) : show.length === 0 ? (
                <EmptyState
                  title="No appointments scheduled"
                  note="Bookings will appear here once appointment sync events arrive."
                />
              ) : (
                <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
                  {(items.length ? items : appointments)
                    .filter((a) => a.status !== "cancelled")
                    .slice(0, 5)
                    .map((a) => (
                      <li key={a.externalAppointmentId} className="muted">
                        {a.status || "booked"}
                        {a.start ? ` · ${a.start.slice(0, 16).replace("T", " ")}` : ""}
                      </li>
                    ))}
                </ul>
              )}
            </Card>
          );
        })}
      </div>
    </AppShell>
  );
}
