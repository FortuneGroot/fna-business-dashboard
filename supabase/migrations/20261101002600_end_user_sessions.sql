-- M27: MFA recovery ends every session of the account (release gate; spec §6.4 A2).
-- Removing a lost authenticator must also cut off whoever may hold the device: an AAL2 access
-- token keeps its `aal` claim until it expires, and a refresh token keeps minting new ones.
-- Supabase Auth has no admin endpoint that signs a user out by id, so this operator function
-- deletes the user's auth.sessions rows (their refresh tokens and MFA claims go with them by
-- foreign-key cascade). With M21 every access token naming a deleted session is refused at once.
-- The deletion and its platform_audit_log row commit together or not at all.

create or replace function public.platform_end_user_sessions(p_user_id uuid, p_reason text, p_metadata jsonb default '{}')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
  v_ended integer;
begin
  if p_user_id is null or length(v_reason) not between 5 and 500
     or jsonb_typeof(coalesce(p_metadata, '{}')) <> 'object' then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  delete from auth.sessions s where s.user_id = p_user_id;
  get diagnostics v_ended = row_count;
  insert into public.platform_audit_log (actor_id, action, reason, metadata)
  values (null, 'platform.sessions_ended', v_reason,
          coalesce(p_metadata, '{}') || jsonb_build_object('user_id', p_user_id, 'sessions_ended', v_ended));
  return jsonb_build_object('ended', v_ended);
end;
$$;

revoke all on function public.platform_end_user_sessions(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.platform_end_user_sessions(uuid, text, jsonb) to service_role;
