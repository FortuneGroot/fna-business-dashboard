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
end;
$$;
