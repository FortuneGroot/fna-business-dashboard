// The synthetic large business shared by tests/acceptance/scale.test.ts (local stack) and
// tests/staging/scale.test.ts (staging): more than 1,000 rows of every list type, with hundreds of
// rows sharing one timestamp so page boundaries fall inside ties. Returns the conversation that
// holds the 1,200 messages.
import type pg from "pg";

export const N = { contacts: 1500, opportunities: 1250, tasks: 1100, conversations: 1050, messages: 1200, appointments: 1100, reviews: 1020, audit: 1100 };

export async function seedBig(db: pg.Client, ws: string, ownerId: string): Promise<string> {
  const tie = "2030-06-01T00:00:00Z";
  let bigConversation = "";
  await db.query("begin");
  try {
    await db.query(
      `insert into public.contacts (workspace_id, first_name, last_name, email, created_at, updated_at, deleted_at)
       select $1, (array['Ava','Ben','Cleo','Dev','Eli','Fay','Gus','Hal','Ivy','Jo'])[1 + i % 10],
              case when i % 12 = 0 then 'Garcia' else 'Surname' || i end, 'person' || i || '@example.test',
              case when i <= 400 then $2::timestamptz else '2029-01-01T00:00:00Z'::timestamptz + i * interval '1 second' + (i % 997) * interval '1 microsecond' end,
              now(), case when i % 35 = 0 then now() end
       from generate_series(1, $3::int) i`, [ws, tie, N.contacts]);
    await db.query(
      `insert into public.contact_tags (workspace_id, contact_id, tag)
       select workspace_id, id, 'vip' from (select workspace_id, id, row_number() over (order by email) rn from public.contacts where workspace_id = $1) c where rn % 5 = 0`, [ws]);
    await db.query(
      `with c as (select id, row_number() over (order by email) rn from public.contacts where workspace_id = $1 and deleted_at is null),
            s as (select ps.id, ps.pipeline_id, ps.kind, row_number() over (order by ps.position) rn, count(*) over () n
                  from public.pipeline_stages ps join public.pipelines p on p.id = ps.pipeline_id and p.is_default where ps.workspace_id = $1)
       insert into public.opportunities (workspace_id, contact_id, pipeline_id, stage_id, title, value_cents, status, created_at, updated_at)
       select $1, c.id, s.pipeline_id, s.id, 'Deal ' || i, i * 100 + 7, case s.kind when 'won' then 'won' when 'lost' then 'lost' else 'open' end,
              case when i <= 300 then $2::timestamptz else '2029-01-01T00:00:00Z'::timestamptz + i * interval '1 second' end, now()
       from generate_series(1, $3::int) i
       join c on c.rn = 1 + (i % 1400)
       join s on s.rn = case when i <= 1050 then 1 else 1 + (i % s.n) end`, [ws, tie, N.opportunities]);
    await db.query(
      `insert into public.tasks (workspace_id, title, status, assigned_user_id, created_at, updated_at)
       select $1, 'Synthetic task ' || i, case when i % 11 < 7 then 'open' else 'done' end, $4,
              case when i <= 300 then $2::timestamptz else '2029-01-01T00:00:00Z'::timestamptz + i * interval '1 second' end, now()
       from generate_series(1, $3::int) i`, [ws, tie, N.tasks, ownerId]);
    await db.query(
      `with c as (select id, row_number() over (order by email) rn from public.contacts where workspace_id = $1 and deleted_at is null)
       insert into public.conversations (workspace_id, contact_id, channel, status, created_at, last_message_at)
       select $1, c.id, 'sms', case when i % 4 = 0 then 'closed' else 'open' end,
              case when i <= 200 then $2::timestamptz else '2029-01-01T00:00:00Z'::timestamptz + i * interval '1 second' end, now()
       from generate_series(1, $3::int) i join c on c.rn = 1 + (i % 1400)`, [ws, tie, N.conversations]);
    bigConversation = (await db.query<{ id: string }>(
      "select id from public.conversations where workspace_id = $1 order by created_at desc, id desc limit 1", [ws])).rows[0].id;
    await db.query(
      `insert into public.messages (workspace_id, conversation_id, direction, body, delivery_status, created_at)
       select $1, $2, case when i % 2 = 0 then 'inbound' else 'outbound' end, 'Synthetic message ' || i, 'delivered',
              case when i <= 250 then $3::timestamptz else '2029-01-01T00:00:00Z'::timestamptz + i * interval '1 second' end
       from generate_series(1, $4::int) i`, [ws, bigConversation, tie, N.messages]);
    const calendar = (await db.query<{ id: string }>(
      "insert into public.calendars (workspace_id, name, slug, timezone, duration_minutes) values ($1, 'Busy chairs', 'busy-chairs', 'America/Chicago', 60) returning id", [ws])).rows[0].id;
    await db.query(
      `with c as (select id, row_number() over (order by email) rn from public.contacts where workspace_id = $1 and deleted_at is null)
       insert into public.appointments (workspace_id, calendar_id, contact_id, starts_at, ends_at, status)
       select $1, $2, c.id, '2031-01-01T00:00:00Z'::timestamptz + i * interval '7 hours', '2031-01-01T01:00:00Z'::timestamptz + i * interval '7 hours',
              case when i % 10 = 0 then 'cancelled' else 'booked' end
       from generate_series(1, $3::int) i join c on c.rn = 1 + (i % 1400)`, [ws, calendar, N.appointments]);
    await db.query(
      `insert into public.reviews (workspace_id, rating, source, body, received_at)
       select $1, 1 + i % 5, 'manual', 'Synthetic review ' || i,
              case when i <= 300 then $2::timestamptz else '2029-01-01T00:00:00Z'::timestamptz + i * interval '1 second' end
       from generate_series(1, $3::int) i`, [ws, tie, N.reviews]);
    await db.query("set local session_replication_role = replica");
    await db.query(
      `insert into public.workspace_audit_log (workspace_id, actor_id, actor_kind, action, target, metadata)
       select $1, $2, 'member', 'contact.updated', 'synthetic-' || i, '{}'::jsonb from generate_series(1, $3::int) i`, [ws, ownerId, N.audit]);
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
  for (const table of ["contacts", "contact_tags", "opportunities", "tasks", "conversations", "messages", "appointments", "reviews", "workspace_audit_log"]) {
    await db.query(`analyze public.${table}`);
  }
  return bigConversation;
}
