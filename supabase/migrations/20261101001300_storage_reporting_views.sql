-- M13: workspace asset storage (when the Supabase storage schema exists) and reporting views.

-- Reporting views run with the caller's privileges, so RLS on the base tables applies.
create view public.pipeline_stage_summary
with (security_invoker = true)
as
select s.workspace_id,
       s.pipeline_id,
       s.id as stage_id,
       s.name as stage_name,
       s.position,
       s.kind,
       count(o.id) as opportunity_count,
       coalesce(sum(o.value_cents), 0)::bigint as value_cents
from public.pipeline_stages s
left join public.opportunities o
  on o.workspace_id = s.workspace_id and o.stage_id = s.id and o.deleted_at is null
group by s.workspace_id, s.pipeline_id, s.id, s.name, s.position, s.kind;

revoke all on public.pipeline_stage_summary from anon, authenticated;
grant select on public.pipeline_stage_summary to authenticated;

-- Audits every workspace-assets object mutation made under a platform access grant (not as a
-- member): actor, workspace, grant, operation, and object path. Row data is read as jsonb so the
-- function compiles without the storage schema.
create function private.audit_grant_storage_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_row jsonb := to_jsonb(coalesce(new, old));
  v_folder text := split_part(v_row ->> 'name', '/', 1);
  v_ws uuid;
  v_grant uuid;
  v_meta jsonb;
begin
  if auth.uid() is null or v_row ->> 'bucket_id' is distinct from 'workspace-assets'
     or v_folder !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  v_ws := v_folder::uuid;
  if private.active_member_role(v_ws) is not null then
    return null;
  end if;
  v_grant := private.active_grant_id(v_ws);
  if v_grant is null then
    return null;
  end if;

  v_meta := jsonb_build_object('operation', lower(tg_op), 'bucket_id', v_row ->> 'bucket_id',
                               'object_path', v_row ->> 'name');
  if tg_op = 'UPDATE' and (to_jsonb(old) ->> 'name') is distinct from (to_jsonb(new) ->> 'name') then
    v_meta := v_meta || jsonb_build_object('previous_object_path', to_jsonb(old) ->> 'name');
  end if;
  insert into public.workspace_audit_log (workspace_id, actor_id, actor_kind, grant_id, action, target, metadata)
  values (v_ws, auth.uid(), 'platform_admin', v_grant, 'storage.object_' || lower(tg_op),
          (v_row ->> 'bucket_id') || '/' || (v_row ->> 'name'), v_meta);
  return null;
end;
$$;

revoke all on function private.audit_grant_storage_write() from public, anon, authenticated;

-- Private bucket for workspace logos, path "{workspace_id}/...".
do $$
begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise notice 'storage schema not present; skipping workspace-assets bucket';
    return;
  end if;

  insert into storage.buckets (id, name, public)
  values ('workspace-assets', 'workspace-assets', false)
  on conflict (id) do nothing;

  execute $p$
    create policy workspace_assets_read on storage.objects for select to authenticated
    using (bucket_id = 'workspace-assets'
           and (storage.foldername(name))[1] = (select private.active_workspace_id())::text
           and (select private.has_permission('settings.read')))
  $p$;
  execute $p$
    create policy workspace_assets_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'workspace-assets'
                and (storage.foldername(name))[1] = (select private.active_workspace_id())::text
                and (select private.has_permission('settings.write')))
  $p$;
  execute $p$
    create policy workspace_assets_update on storage.objects for update to authenticated
    using (bucket_id = 'workspace-assets'
           and (storage.foldername(name))[1] = (select private.active_workspace_id())::text
           and (select private.has_permission('settings.write')))
  $p$;
  execute $p$
    create policy workspace_assets_delete on storage.objects for delete to authenticated
    using (bucket_id = 'workspace-assets'
           and (storage.foldername(name))[1] = (select private.active_workspace_id())::text
           and (select private.has_permission('settings.write')))
  $p$;
  execute $t$
    create trigger workspace_assets_audit_grant_write
      after insert or update or delete on storage.objects
      for each row execute function private.audit_grant_storage_write()
  $t$;
end;
$$;
