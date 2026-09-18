import { AppShell } from "@/components/AppShell";
import { StatusBanner } from "@/components/Chrome";
import { Card, PageHead, EmptyState } from "@/components/ui";
import { WaitingForSync } from "@/components/WaitingForSync";
import { getSyncStore } from "@/lib/sync";
import {
  configuredCalendars,
  looksLikePlaceholderCalendars,
} from "@/lib/tenant-ui";
import {
  PLACEHOLDER_CONFIG_CALENDARS,
  SYNC_SOURCE_SHORT,
  syncBannerWaiting,
  syncColumnEmpty,
} from "@/lib/ui/sync-copy";

export const dynamic = "force-dynamic";

export default async function CalendarPage() {
  const appointments = await getSyncStore().listAppointments();
  const waiting = appointments.length === 0;
  const calendars = configuredCalendars();
  const calendarsBlocked = looksLikePlaceholderCalendars();

  return (
    <AppShell>
      <PageHead
        title="Calendars"
        description={`Bookings from connected appointment workflows. A website form preferred time is still a request, not a reserved slot. ${SYNC_SOURCE_SHORT}`}
      />

      <StatusBanner>
        {calendarsBlocked
          ? PLACEHOLDER_CONFIG_CALENDARS
          : waiting
            ? syncBannerWaiting("appointments")
            : `${appointments.length} appointment(s) synced.`}
      </StatusBanner>

      {waiting ? (
        <div style={{ marginTop: "1.1rem" }}>
          <WaitingForSync entity="appointments" />
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
