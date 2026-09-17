-- Auth session store for V1 logout revocation.
-- Apply manually to Supabase before relying on multi-instance session revoke.
-- Do NOT auto-apply against Production from this repo.

create table if not exists auth_sessions (
  id text primary key,
  email text not null,
  role text not null check (role in ('OWNER', 'ADMIN', 'CLIENT')),
  name text not null default '',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked boolean not null default false
);

create index if not exists auth_sessions_expires_idx on auth_sessions (expires_at);
create index if not exists auth_sessions_email_idx on auth_sessions (email);
