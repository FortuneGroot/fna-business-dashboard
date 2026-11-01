import { AppShell } from "@/components/AppShell";
import { StatusBanner } from "@/components/Chrome";
import { Card, PageHead, EmptyState, Button } from "@/components/ui";
import { WaitingForSync } from "@/components/WaitingForSync";
import { getPageData } from "@/lib/data";
import { PLACEHOLDER_CONFIG_CALENDARS, dataCopy, syncColumnEmpty } from "@/lib/ui/sync-copy";

export const dynamic = "force-dynamic";

export default async function CalendarPage() {
  const data = await getPageData();
  const { native } = data;
  const copy = dataCopy(native);
  const [appointments, workspace] = await Promise.all([data.reader.listAppointments(), data.workspace()]);
  const waiting = appointments.length === 0;
  const calendars = workspace.calendars;
  const calendarsBlocked = !workspace.calendarsConfigured;
  const noNativeCalendars = native && calendars.length === 0;
  const statusCounts = appointments.reduce<Record<string, number>>((acc, a) => {
    const key = (a.status || "booked").toLowerCase();
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const statusSummary = Object.entries(statusCounts)
    .map(([k, n]) => `${n} ${k}`)
    .join(" · ");

  return (
    <AppShell>
      <PageHead
        title="Calendars"
        description={`${
          native ? "Bookings on this workspace's calendars." : "Bookings from connected appointment workflows."
        } A website form preferred time is still a request, not a reserved slot. ${copy.sourceShort}`}
      />

      <StatusBanner>
        {noNativeCalendars
          ? copy.bannerWaiting("calendars")
          : calendarsBlocked
            ? PLACEHOLDER_CONFIG_CALENDARS
            : waiting
              ? copy.bannerWaiting("appointments")
              : `${appointments.length} appointment(s)${native ? "" : " synced"}${statusSummary ? ` — ${statusSummary}` : ""}.`}
      </StatusBanner>

      {noNativeCalendars ? (
        <div style={{ marginTop: "1.1rem" }}>
          <Card
            title="Calendars"
            action={
              data.can("calendar.configure") ? (
                <Button size="sm" variant="secondary" disabled>
                  Create calendar (coming soon)
                </Button>
              ) : undefined
            }
          >
            <EmptyState title="No calendars yet" note="Calendars created for this workspace appear here." />
          </Card>
        </div>
      ) : waiting ? (
        <div style={{ marginTop: "1.1rem" }}>
          <WaitingForSync entity="appointments" native={native} />
        </div>
      ) : null}

      <div className="grid grid-3" style={{ marginTop: "1.1rem" }}>
        {calendars.map((cal) => {
          const items = appointments.filter(
            (a) =>
              !a.calendarName ||
              a.calendarName.toLowerCase() === cal.name.toLowerCase() ||
              a.calendarId === cal.id ||
              a.calendarName.toLowerCase().includes(cal.name.toLowerCase().split(" ")[0])
          );
          return (
            <Card key={cal.name} title={cal.name}>
              <p className="muted" style={{ marginTop: 0 }}>
                Duration: {cal.duration || "—"}
              </p>
              {waiting ? (
                <p className="muted" style={{ margin: 0 }}>
                  {syncColumnEmpty()}
                </p>
              ) : items.length === 0 && appointments.length === 0 ? (
                <EmptyState title="No appointments scheduled" />
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
