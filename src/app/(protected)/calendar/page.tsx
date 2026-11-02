import { AppShell } from "@/components/AppShell";
import { StatusBanner } from "@/components/Chrome";
import { Card, PageHead, EmptyState } from "@/components/ui";
import { WaitingForSync } from "@/components/WaitingForSync";
import { BookAppointment, CalendarEditor, EditAppointment } from "@/components/records/NativeCalendar";
import { getPageData, getPageScope } from "@/lib/data";
import { listCalendars, type CalendarItem } from "@/lib/native/calendars";
import { calendarAppointments, soonestFirst } from "@/lib/ui/board";
import { PLACEHOLDER_CONFIG_CALENDARS, dataCopy, syncColumnEmpty } from "@/lib/ui/sync-copy";

export const dynamic = "force-dynamic";

/** Native booking times are shown in UTC (CRUD-3) and say so; the booking form uses local time. */
function utcLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export default async function CalendarPage() {
  const now = Date.now();
  const data = await getPageData();
  const { native } = data;
  const copy = dataCopy(native);
  const [appointments, workspace, nativeCalendars] = await Promise.all([
    data.reader.listAppointments(),
    data.workspace(),
    native ? getPageScope().then(listCalendars) : Promise.resolve([] as CalendarItem[]),
  ]);
  const waiting = appointments.length === 0;
  const calendars = workspace.calendars;
  const calendarsBlocked = !workspace.calendarsConfigured;
  const noNativeCalendars = native && nativeCalendars.length === 0;
  const canConfigure = native && data.can("calendar.configure");
  const canBook = native && data.can("appointments.write");
  const inactive = nativeCalendars.filter((c) => !c.active);
  const bookable = nativeCalendars.filter((c) => c.active).map((c) => ({ id: c.id, name: c.name, durationMinutes: c.durationMinutes }));
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
        action={
          native && !noNativeCalendars && (canBook || canConfigure) ? (
            <div className="quick-actions">
              {canBook && bookable.length ? <BookAppointment calendars={bookable} /> : null}
              {canConfigure ? <CalendarEditor label="Create calendar" /> : null}
            </div>
          ) : undefined
        }
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
          <Card title="Calendars" action={canConfigure ? <CalendarEditor label="Create calendar" /> : undefined}>
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
          const shown = calendarAppointments(native, cal, appointments);
          const live = shown.filter((a) => a.status !== "cancelled");
          const visible = native ? soonestFirst(live, now) : live;
          return (
            <Card
              key={native ? cal.id : cal.name}
              title={cal.name}
              action={canConfigure ? <CalendarEditor calendarId={cal.id} label="Edit" /> : undefined}
            >
              <p className="muted" style={{ marginTop: 0 }}>
                Duration: {cal.duration || "—"}
              </p>
              {waiting ? (
                <p className="muted" style={{ margin: 0 }}>
                  {syncColumnEmpty()}
                </p>
              ) : (native ? visible.length === 0 : shown.length === 0) ? (
                <EmptyState title="No appointments scheduled" />
              ) : (
                <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
                  {visible
                    .slice(0, 5)
                    .map((a) => (
                      <li key={a.externalAppointmentId} className="muted">
                        {a.status || "booked"}
                        {a.start ? ` · ${native ? utcLabel(a.start) : a.start.slice(0, 16).replace("T", " ")}` : ""}
                        {canBook && a.start && a.end ? (
                          <EditAppointment
                            appointment={{ id: a.externalAppointmentId, startsAt: a.start, endsAt: a.end, status: a.status || "booked" }}
                          />
                        ) : null}
                      </li>
                    ))}
                </ul>
              )}
            </Card>
          );
        })}
        {inactive.map((cal) => (
          <Card key={cal.id} title={cal.name} action={canConfigure ? <CalendarEditor calendarId={cal.id} label="Edit" /> : undefined}>
            <p className="muted" style={{ margin: 0 }}>Not accepting bookings.</p>
          </Card>
        ))}
      </div>
    </AppShell>
  );
}
