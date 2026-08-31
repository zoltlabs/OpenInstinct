-- Phase 1: persistent browser identity. Provider IDs and control sessions remain server-only.

do $$
begin
  if exists (
    select 1 from public.browser_profiles
    where char_length(provider) not between 1 and 64
      or char_length(provider_profile_id) not between 1 and 500
      or char_length(label) not between 1 and 200
  ) then
    raise exception 'browser_profiles contains legacy values outside Phase 1 bounds; shorten provider, provider_profile_id, or label before retrying migration';
  end if;
end;
$$;

alter table public.browser_profiles
  alter column provider_profile_id drop not null,
  add column status text not null default 'active'
    check (status in ('provisioning','needs_login','active','needs_reauth','revoked','error')),
  add column configuration_version bigint not null default 1 check (configuration_version > 0),
  add column provider_capabilities jsonb not null default '{}'::jsonb
    check (jsonb_typeof(provider_capabilities) = 'object' and octet_length(provider_capabilities::text) <= 16000),
  add column capabilities_hash text,
  add column capabilities_checked_at timestamptz,
  add column last_health_checked_at timestamptz,
  add column last_authenticated_at timestamptz,
  add column revoked_at timestamptz,
  add column deletion_requested_at timestamptz,
  add column deletion_verified_at timestamptz,
  add column last_error_code text check (last_error_code is null or char_length(last_error_code) between 1 and 128),
  add column updated_at timestamptz not null default now(),
  add constraint browser_profiles_id_workspace_unique unique (id, workspace_id),
  add constraint browser_profiles_provider_bounds check (char_length(provider) between 1 and 64),
  add constraint browser_profiles_provider_id_bounds check (provider_profile_id is null or char_length(provider_profile_id) between 1 and 500),
  add constraint browser_profiles_label_bounds check (char_length(label) between 1 and 200),
  add constraint browser_profiles_capabilities_hash_format check (capabilities_hash is null or capabilities_hash ~ '^[0-9a-f]{64}$'),
  add constraint browser_profiles_provider_required check (status in ('provisioning','error') or provider_profile_id is not null),
  add constraint browser_profiles_revocation_state check ((status = 'revoked') = (revoked_at is not null)),
  add constraint browser_profiles_deletion_order check (deletion_verified_at is null or deletion_requested_at is not null),
  add constraint browser_profiles_deletion_state check (
    (deletion_requested_at is null and deletion_verified_at is null) or status = 'revoked'
  ),
  add constraint browser_profiles_deletion_timing check (
    deletion_verified_at is null or deletion_verified_at >= deletion_requested_at
  );

create trigger browser_profiles_updated before update on public.browser_profiles
for each row execute function app_private.set_updated_at();

create table public.browser_profile_origins (
  profile_id uuid not null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  origin text not null check (
    origin ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$'
    and char_length(origin) <= 500
  ),
  created_at timestamptz not null default now(),
  primary key (profile_id, origin),
  foreign key (profile_id, workspace_id)
    references public.browser_profiles(id, workspace_id) on delete cascade
);

create table app_private.browser_control_sessions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null,
  workspace_id uuid not null,
  provider_session_id text not null check (char_length(provider_session_id) between 1 and 500),
  purpose text not null check (purpose in ('enrollment','reauthentication','health','takeover')),
  status text not null check (status in ('active','cleanup_pending','completed','expired','failed','closed')),
  takeover_nonce_hash text check (takeover_nonce_hash is null or takeover_nonce_hash ~ '^[0-9a-f]{64}$'),
  takeover_accessed_at timestamptz,
  authentication_verified boolean,
  configuration_version bigint not null check (configuration_version > 0),
  expires_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (provider_session_id),
  foreign key (profile_id, workspace_id)
    references public.browser_profiles(id, workspace_id) on delete cascade,
  check ((status in ('active','cleanup_pending')) = (completed_at is null)),
  check ((status = 'completed') = (authentication_verified is not null)),
  check (expires_at > created_at)
);

create index browser_profiles_workspace_status_label_idx
on public.browser_profiles (workspace_id, status, label);
create index browser_profiles_pending_deletion_idx
on public.browser_profiles (deletion_requested_at)
where deletion_requested_at is not null and deletion_verified_at is null;
create index browser_profile_origins_workspace_idx
on public.browser_profile_origins (workspace_id, profile_id);
create index browser_control_sessions_active_idx
on app_private.browser_control_sessions (workspace_id, profile_id, expires_at)
where status = 'active';
create unique index browser_control_sessions_one_active_profile_idx
on app_private.browser_control_sessions (profile_id)
where status in ('active','cleanup_pending');
create unique index browser_control_sessions_nonce_idx
on app_private.browser_control_sessions (takeover_nonce_hash)
where takeover_nonce_hash is not null;
create index browser_control_sessions_profile_fk_idx
on app_private.browser_control_sessions (profile_id, workspace_id);
create index browser_control_sessions_cleanup_pending_idx
on app_private.browser_control_sessions (expires_at)
where status = 'cleanup_pending';

alter table public.browser_profile_origins enable row level security;
create policy browser_profile_origins_select_owner on public.browser_profile_origins
for select to authenticated using (exists (
  select 1 from public.workspaces w
  where w.id = workspace_id and w.owner_user_id = (select auth.uid())
));

drop policy browser_profiles_insert_owner on public.browser_profiles;
drop policy browser_profiles_update_owner on public.browser_profiles;
drop policy browser_profiles_delete_owner on public.browser_profiles;
revoke all on public.browser_profiles from anon, authenticated;
revoke all on public.browser_profile_origins from anon, authenticated;
grant select (
  id, workspace_id, provider, label, status, configuration_version,
  last_health_checked_at, last_authenticated_at, revoked_at,
  deletion_requested_at, deletion_verified_at, created_at, updated_at
) on public.browser_profiles to authenticated;
grant select on public.browser_profile_origins to authenticated;
revoke all on app_private.browser_control_sessions from public, anon, authenticated, service_role;

create view public.browser_profile_summaries with (security_invoker = true) as
select p.id, p.workspace_id, p.provider, p.label, p.status,
  p.configuration_version, p.last_health_checked_at, p.last_authenticated_at,
  p.revoked_at, p.deletion_requested_at, p.deletion_verified_at,
  p.created_at, p.updated_at,
  coalesce(array_agg(o.origin order by o.origin) filter (where o.origin is not null), '{}') as allowed_origins
from public.browser_profiles p
left join public.browser_profile_origins o
  on o.profile_id = p.id and o.workspace_id = p.workspace_id
group by p.id;
revoke all on public.browser_profile_summaries from public, anon, authenticated;
grant select on public.browser_profile_summaries to authenticated;

comment on table app_private.browser_control_sessions is
  'Server-only opaque provider session references. Never stores live-view URLs, tokens, cookies, screenshots, replays, or profile contents.';

create or replace function app_private.purge_workspace_execution_history(target_workspace_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() <> 'service_role' and current_user not in ('postgres', 'supabase_admin') then
    raise exception 'workspace purge requires the trusted server role' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.browser_profiles where workspace_id = target_workspace_id
  ) then
    raise exception 'provider browser profiles must be verifiably deleted before workspace purge'
      using errcode = '55000';
  end if;
  perform set_config('app_private.execution_history_purge_workspace', target_workspace_id::text, true);
  delete from public.run_events where workspace_id = target_workspace_id;
  delete from public.audit_events where workspace_id = target_workspace_id;
  delete from public.tool_results where workspace_id = target_workspace_id and reconciles_result_id is not null;
  delete from public.tool_results where workspace_id = target_workspace_id;
  delete from public.workspaces where id = target_workspace_id;
end;
$$;
