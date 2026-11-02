"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Modal } from "@/components/ui";
import {
  SKIPPED_TIME_MESSAGE,
  api,
  failure,
  fromLocalInput,
  isSkippedLocalTime,
  loadMembers,
  toLocalInput,
  type Member,
} from "@/lib/ui/native-api";
import { ContactPicker, MemberSelect } from "./pickers";

/* Calendar and appointment controls for native workspaces (AUTH_PROVIDER=supabase). Cards stay
 * server-rendered; these islands call /api/calendars and /api/appointments and refresh the page. */

type Rule = { weekday: number; start: string; end: string };
type Calendar = {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  durationMinutes: number;
  active: boolean;
  members: { userId: string; name: string | null }[];
  rules: Rule[];
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const STATUSES = ["booked", "confirmed", "completed", "cancelled", "no_show"] as const;

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

function useMembers(open: boolean) {
  const [members, setMembers] = useState<Member[]>([]);
  useEffect(() => {
    if (open && !members.length) void loadMembers().then(setMembers);
  }, [open, members.length]);
  return members;
}

const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York";
  } catch {
    return "America/New_York";
  }
};

/** Create a calendar (no `calendarId`) or edit one: fields, members, and weekly availability. */
export function CalendarEditor({ calendarId, label }: { calendarId?: string; label: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Calendar | null>(null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [timezone, setTimezone] = useState("");
  const [duration, setDuration] = useState("30");
  const [active, setActive] = useState(true);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const members = useMembers(open);

  async function show() {
    setOpen(true);
    setError("");
    if (!calendarId) {
      setCreatedId(null);
      setLoaded(null);
      setName("");
      setSlug("");
      setSlugTouched(false);
      setTimezone(browserZone());
      setDuration("30");
      setActive(true);
      setMemberIds([]);
      setRules([1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: "09:00", end: "17:00" })));
      return;
    }
    const { body } = await api("/api/calendars");
    const cal = body.ok ? (body.items as Calendar[]).find((c) => c.id === calendarId) : undefined;
    if (!cal) {
      setError(failure(body, "Could not load this calendar."));
      return;
    }
    setLoaded(cal);
    setName(cal.name);
    setSlug(cal.slug);
    setSlugTouched(true);
    setTimezone(cal.timezone);
    setDuration(String(cal.durationMinutes));
    setActive(cal.active);
    setMemberIds(cal.members.map((m) => m.userId));
    setRules(cal.rules);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const fields = { name, slug, timezone, durationMinutes: Number(duration), active, memberUserIds: memberIds };
    const existing = calendarId ?? createdId;
    const { body } = await api(existing ? `/api/calendars/${existing}` : "/api/calendars", {
      method: existing ? "PATCH" : "POST",
      body: JSON.stringify(fields),
    });
    if (!body.ok) {
      setBusy(false);
      setError(failure(body, "Could not save the calendar."));
      return;
    }
    const id = (body.calendar as Calendar).id;
    if (!calendarId) setCreatedId(id);
    const avail = await api(`/api/calendars/${id}/availability`, { method: "PUT", body: JSON.stringify({ rules }) });
    setBusy(false);
    if (!avail.body.ok) {
      // No refresh while the dialog is open: a first calendar swaps the page layout, which would
      // unmount this editor and hide the error.
      setError(failure(avail.body, "The calendar was saved, but its availability was not."));
      return;
    }
    setOpen(false);
    router.refresh();
  }

  function close() {
    setOpen(false);
    router.refresh();
  }

  const setRule = (i: number, patch: Partial<Rule>) => setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => void show()}>
        {label}
      </Button>
      <Modal open={open} onClose={close} title={calendarId ? `Edit ${loaded?.name ?? "calendar"}` : "Create calendar"}>
        {error ? <div className="banner error" role="alert">{error}</div> : null}
        {calendarId && !loaded ? null : (
          <form onSubmit={save} aria-label="Calendar">
            <label htmlFor="cal-name">Name</label>
            <input
              id="cal-name"
              value={name}
              maxLength={120}
              required
              onChange={(e) => {
                setName(e.target.value);
                if (!slugTouched) setSlug(slugify(e.target.value));
              }}
            />
            <label htmlFor="cal-slug">Link name</label>
            <input id="cal-slug" value={slug} maxLength={60} required onChange={(e) => { setSlug(e.target.value); setSlugTouched(true); }} />
            <div className="grid grid-2">
              <div>
                <label htmlFor="cal-zone">Timezone</label>
                <input id="cal-zone" value={timezone} onChange={(e) => setTimezone(e.target.value)} required />
              </div>
              <div>
                <label htmlFor="cal-duration">Duration (minutes)</label>
                <input id="cal-duration" type="number" min={5} max={480} step={5} value={duration} onChange={(e) => setDuration(e.target.value)} required />
              </div>
            </div>
            <label className="check">
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
              <span>Accepting bookings</span>
            </label>
            <fieldset style={{ border: 0, padding: 0, margin: "0.8rem 0 0" }}>
              <legend>Team members on this calendar</legend>
              {members.length === 0 ? <p className="muted">Loading team…</p> : null}
              {members.map((m) => (
                <label key={m.userId} className="check">
                  <input
                    type="checkbox"
                    checked={memberIds.includes(m.userId)}
                    onChange={(e) =>
                      setMemberIds((ids) => (e.target.checked ? [...ids, m.userId] : ids.filter((x) => x !== m.userId)))
                    }
                  />
                  <span>{m.name || m.email}</span>
                </label>
              ))}
            </fieldset>
            <fieldset style={{ border: 0, padding: 0, margin: "0.8rem 0 0" }}>
              <legend>Weekly availability ({timezone || "calendar timezone"})</legend>
              {rules.length === 0 ? <p className="muted">No availability set.</p> : null}
              {rules.map((r, i) => (
                <div key={i} className="grid grid-4" style={{ alignItems: "end", gap: "0.5rem" }}>
                  <div>
                    <label htmlFor={`rule-day-${i}`}>Day</label>
                    <select id={`rule-day-${i}`} value={r.weekday} onChange={(e) => setRule(i, { weekday: Number(e.target.value) })}>
                      {WEEKDAYS.map((d, n) => (
                        <option key={d} value={n}>{d}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor={`rule-start-${i}`}>From</label>
                    <input id={`rule-start-${i}`} type="time" value={r.start} onChange={(e) => setRule(i, { start: e.target.value })} required />
                  </div>
                  <div>
                    <label htmlFor={`rule-end-${i}`}>To</label>
                    <input id={`rule-end-${i}`} type="time" value={r.end} onChange={(e) => setRule(i, { end: e.target.value })} required />
                  </div>
                  <div>
                    <Button size="sm" variant="ghost" onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}>
                      Remove
                    </Button>
                  </div>
                </div>
              ))}
              <Button size="sm" variant="ghost" onClick={() => setRules((rs) => [...rs, { weekday: 1, start: "09:00", end: "17:00" }])}>
                Add hours
              </Button>
            </fieldset>
            <div style={{ marginTop: "0.8rem" }}>
              <Button type="submit" disabled={busy}>{calendarId ? "Save calendar" : "Create calendar"}</Button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}

export type BookingCalendar = { id: string; name: string; durationMinutes: number };

export function BookAppointment({ calendars }: { calendars: BookingCalendar[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [calendarId, setCalendarId] = useState(calendars[0]?.id ?? "");
  const [contactId, setContactId] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [assignee, setAssignee] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const members = useMembers(open);

  const minutes = calendars.find((c) => c.id === calendarId)?.durationMinutes ?? 30;
  function onStart(value: string) {
    setStart(value);
    const iso = fromLocalInput(value);
    if (iso) setEnd(toLocalInput(new Date(Date.parse(iso) + minutes * 60_000).toISOString()));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const startsAt = fromLocalInput(start);
    const endsAt = fromLocalInput(end);
    if (!startsAt || !endsAt) {
      setError("Choose a start and end time.");
      return;
    }
    if (isSkippedLocalTime(start) || isSkippedLocalTime(end)) {
      setError(SKIPPED_TIME_MESSAGE);
      return;
    }
    setBusy(true);
    const { status, body } = await api("/api/appointments", {
      method: "POST",
      body: JSON.stringify({ calendarId, contactId, startsAt, endsAt, assignedUserId: assignee || null, notes }),
    });
    setBusy(false);
    if (!body.ok) {
      setError(status === 409 ? "That time overlaps another booking on this calendar." : failure(body, "Could not book the appointment."));
      return;
    }
    setOpen(false);
    setStart("");
    setEnd("");
    setNotes("");
    setError("");
    router.refresh();
  }

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)} disabled={!calendars.length}>
        Book appointment
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Book appointment">
        <form onSubmit={submit} aria-label="Book appointment">
          {error ? <div className="banner error" role="alert">{error}</div> : null}
          <label htmlFor="appt-calendar">Calendar</label>
          <select id="appt-calendar" value={calendarId} onChange={(e) => setCalendarId(e.target.value)}>
            {calendars.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <ContactPicker id="appt-contact" value={contactId} onChange={setContactId} />
          <div className="grid grid-2">
            <div>
              <label htmlFor="appt-start">Starts (your local time)</label>
              <input id="appt-start" type="datetime-local" value={start} onChange={(e) => onStart(e.target.value)} required />
            </div>
            <div>
              <label htmlFor="appt-end">Ends (your local time)</label>
              <input id="appt-end" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} required />
            </div>
          </div>
          <MemberSelect id="appt-assignee" label="Assigned to" value={assignee} members={members} onChange={setAssignee} />
          <label htmlFor="appt-notes">Notes</label>
          <textarea id="appt-notes" rows={3} maxLength={10000} value={notes} onChange={(e) => setNotes(e.target.value)} />
          <div style={{ marginTop: "0.8rem" }}>
            <Button type="submit" disabled={busy}>Book appointment</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

export type EditableAppointment = { id: string; startsAt: string; endsAt: string; status: string };

export function EditAppointment({ appointment }: { appointment: EditableAppointment }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [status, setStatus] = useState(appointment.status);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function show() {
    setStart(toLocalInput(appointment.startsAt));
    setEnd(toLocalInput(appointment.endsAt));
    setStatus(appointment.status);
    setError("");
    setOpen(true);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const startsAt = fromLocalInput(start);
    const endsAt = fromLocalInput(end);
    if (!startsAt || !endsAt) {
      setError("Choose a start and end time.");
      return;
    }
    if (isSkippedLocalTime(start) || isSkippedLocalTime(end)) {
      setError(SKIPPED_TIME_MESSAGE);
      return;
    }
    const patch: Record<string, unknown> = {};
    if (startsAt !== new Date(appointment.startsAt).toISOString()) patch.startsAt = startsAt;
    if (endsAt !== new Date(appointment.endsAt).toISOString()) patch.endsAt = endsAt;
    if (status !== appointment.status) patch.status = status;
    if (!Object.keys(patch).length) {
      setOpen(false);
      return;
    }
    setBusy(true);
    const res = await api(`/api/appointments/${appointment.id}`, { method: "PATCH", body: JSON.stringify(patch) });
    setBusy(false);
    if (!res.body.ok) {
      setError(res.status === 409 ? "That time overlaps another booking on this calendar." : failure(res.body, "Could not save the appointment."));
      return;
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      {" "}
      <button type="button" className="btn ghost sm" onClick={show} aria-label="Edit appointment">
        Edit
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Edit appointment">
        <form onSubmit={save} aria-label="Edit appointment">
          {error ? <div className="banner error" role="alert">{error}</div> : null}
          <div className="grid grid-2">
            <div>
              <label htmlFor={`as-${appointment.id}`}>Starts (your local time)</label>
              <input id={`as-${appointment.id}`} type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} required />
            </div>
            <div>
              <label htmlFor={`ae-${appointment.id}`}>Ends (your local time)</label>
              <input id={`ae-${appointment.id}`} type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} required />
            </div>
          </div>
          <label htmlFor={`ast-${appointment.id}`}>Status</label>
          <select id={`ast-${appointment.id}`} value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s.replace("_", " ")}</option>
            ))}
          </select>
          <div style={{ marginTop: "0.8rem" }}>
            <Button type="submit" disabled={busy}>Save appointment</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
