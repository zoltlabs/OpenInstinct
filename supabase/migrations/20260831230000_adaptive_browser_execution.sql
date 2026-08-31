-- Phase 2: adaptive read-only browser execution and provider-neutral artifacts.
-- Raw browser state, provider handles, leases, decisions, and storage paths are private.

alter table public.browser_profiles
add constraint browser_profiles_id_workspace_configuration_key
unique (id, workspace_id, configuration_version);

create table public.browser_executions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid not null,
  step_id uuid not null,
  profile_id uuid,
  profile_configuration_version bigint check (
    profile_configuration_version is null or profile_configuration_version > 0
  ),
  mode text not null check (mode in ('ephemeral_read_only','persistent_read_only')),
  status text not null default 'queued' check (status in (
    'queued','running','waiting_owner','cleanup_pending','completed',
    'failed','unknown','cancelled'
  )),
  goal_hash text not null check (goal_hash ~ '^[0-9a-f]{64}$'),
  policy_hash text not null check (policy_hash ~ '^[0-9a-f]{64}$'),
  max_steps integer not null check (max_steps between 1 and 50),
  steps_completed integer not null default 0 check (steps_completed >= 0),
  max_duration_seconds integer not null check (max_duration_seconds between 10 and 3600),
  max_cost_units integer not null check (max_cost_units between 1 and 1000),
  cost_units_used integer not null default 0 check (cost_units_used >= 0),
  last_error_code text check (last_error_code is null or char_length(last_error_code) between 1 and 128),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  unique (id, run_id, workspace_id),
  unique (id, step_id, workspace_id),
  unique (step_id),
  check (steps_completed <= max_steps),
  check (cost_units_used <= max_cost_units),
  check ((status in ('completed','failed','unknown','cancelled')) = (completed_at is not null)),
  check (
    mode = 'ephemeral_read_only' or profile_id is not null
      or status in ('completed','failed','unknown','cancelled')
  ),
  check ((profile_id is null) = (profile_configuration_version is null)),
  foreign key (run_id, workspace_id)
    references public.agent_runs(id, workspace_id) on delete cascade,
  foreign key (step_id, run_id, workspace_id)
    references public.workflow_steps(id, run_id, workspace_id) on delete cascade,
  foreign key (profile_id, workspace_id, profile_configuration_version)
    references public.browser_profiles(id, workspace_id, configuration_version)
    on delete set null (profile_id, profile_configuration_version)
);

create table app_private.browser_execution_handles (
  execution_id uuid primary key,
  workspace_id uuid not null,
  provider text not null check (char_length(provider) between 1 and 64),
  correlation_id uuid not null unique,
  provider_session_id text unique check (
    provider_session_id is null or char_length(provider_session_id) between 1 and 500
  ),
  provider_phase text not null default 'not_started' check (provider_phase in (
    'not_started','start_requested','session_bound','guards_installed',
    'cleanup_requested','deleted','cleanup_unknown'
  )),
  lease_epoch bigint not null default 0 check (lease_epoch >= 0),
  lease_token_hash text check (lease_token_hash is null or lease_token_hash ~ '^[0-9a-f]{64}$'),
  lease_expires_at timestamptz,
  session_expires_at timestamptz,
  allowed_origins jsonb not null check (
    jsonb_typeof(allowed_origins) = 'array'
    and jsonb_array_length(allowed_origins) between 1 and 20
    and octet_length(allowed_origins::text) <= 12000
  ),
  start_url text not null check (char_length(start_url) between 9 and 2000),
  goal text not null check (char_length(goal) between 1 and 8000),
  controller text,
  updated_at timestamptz not null default now(),
  foreign key (execution_id, workspace_id)
    references public.browser_executions(id, workspace_id) on delete cascade,
  check ((lease_token_hash is null) = (lease_expires_at is null)),
  check (provider_phase in ('not_started','start_requested','deleted') or provider_session_id is not null)
);

create table app_private.browser_execution_slices (
  id uuid primary key default gen_random_uuid(),
  execution_id uuid not null,
  workspace_id uuid not null,
  ordinal integer not null check (ordinal between 0 and 49),
  lease_epoch bigint check (lease_epoch is null or lease_epoch > 0),
  status text not null default 'queued' check (status in (
    'queued','claimed','observation_recorded','action_validated',
    'invocation_started','action_applied','completed','failed','unknown'
  )),
  cost_reserved boolean not null default false,
  observation_hash text check (observation_hash is null or observation_hash ~ '^[0-9a-f]{64}$'),
  redacted_observation jsonb check (
    redacted_observation is null or (
      jsonb_typeof(redacted_observation) = 'object'
      and octet_length(redacted_observation::text) <= 64000
    )
  ),
  decision jsonb check (
    decision is null or (jsonb_typeof(decision) = 'object' and octet_length(decision::text) <= 16000)
  ),
  decision_hash text check (decision_hash is null or decision_hash ~ '^[0-9a-f]{64}$'),
  action_hash text check (action_hash is null or action_hash ~ '^[0-9a-f]{64}$'),
  result_hash text check (result_hash is null or result_hash ~ '^[0-9a-f]{64}$'),
  last_error_code text check (last_error_code is null or char_length(last_error_code) between 1 and 128),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (execution_id, ordinal),
  unique (id, execution_id, workspace_id),
  foreign key (execution_id, workspace_id)
    references public.browser_executions(id, workspace_id) on delete cascade,
  check (status <> 'queued' or lease_epoch is null),
  check ((status in ('completed','failed','unknown')) = (completed_at is not null))
);

create table public.browser_handoffs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  execution_id uuid not null,
  status text not null default 'requested' check (
    status in ('requested','active','completed','expired','cancelled')
  ),
  reason_code text not null check (char_length(reason_code) between 1 and 128),
  expires_at timestamptz not null,
  first_accessed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (execution_id, workspace_id)
    references public.browser_executions(id, workspace_id) on delete cascade,
  check (expires_at > created_at and expires_at <= created_at + interval '30 minutes'),
  check ((status='completed') = (completed_at is not null))
);

create table app_private.browser_handoff_handles (
  handoff_id uuid primary key,
  workspace_id uuid not null,
  provider_session_id text not null check (char_length(provider_session_id) between 1 and 500),
  notification_status text not null default 'pending' check (
    notification_status in ('pending','sent')
  ),
  notification_attempts integer not null default 0 check (notification_attempts between 0 and 100),
  notification_sent_at timestamptz,
  access_count integer not null default 0 check (access_count between 0 and 20),
  last_accessed_at timestamptz,
  foreign key (handoff_id, workspace_id)
    references public.browser_handoffs(id, workspace_id) on delete cascade
);

create table public.artifacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  browser_execution_id uuid,
  step_id uuid,
  kind text not null check (kind in ('screenshot','dom','download','upload','receipt','trace')),
  sensitivity text not null check (sensitivity in ('public','personal','sensitive','secret')),
  state text not null check (state in (
    'pending_upload','quarantined','scanning','available','rejected',
    'deletion_pending','deleted','deletion_unknown'
  )),
  display_name text not null check (char_length(display_name) between 1 and 200),
  declared_mime_type text not null check (char_length(declared_mime_type) between 3 and 200),
  detected_mime_type text check (detected_mime_type is null or char_length(detected_mime_type) between 3 and 200),
  size_bytes bigint check (size_bytes is null or size_bytes between 0 and 25000000),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  scan_verdict text check (scan_verdict is null or scan_verdict in ('clean','malicious','unsupported','error')),
  scan_version text check (scan_version is null or char_length(scan_version) between 1 and 100),
  scan_code text check (scan_code is null or char_length(scan_code) between 1 and 128),
  redaction_status text check (redaction_status is null or redaction_status in ('redacted','withheld','not_applicable')),
  redaction_version text check (redaction_version is null or char_length(redaction_version) between 1 and 100),
  created_at timestamptz not null default now(),
  available_at timestamptz,
  deletion_requested_at timestamptz,
  deletion_verified_at timestamptz,
  deletion_recheck_until timestamptz,
  next_deletion_check_at timestamptz,
  retention_expires_at timestamptz not null default (now() + interval '7 days'),
  unique (id, workspace_id),
  check (
    state <> 'available' or (
      available_at is not null and scan_verdict='clean' and sha256 is not null
      and size_bytes is not null and detected_mime_type is not null
    )
  ),
  check (state not in ('available','rejected') or scan_verdict is not null),
  check (
    kind not in ('screenshot','dom') or state not in ('available','rejected')
      or (redaction_status in ('redacted','withheld') and redaction_version is not null)
  ),
  check (deletion_verified_at is null or deletion_requested_at is not null),
  check (state <> 'deleted' or deletion_verified_at is not null),
  check (deletion_recheck_until is null or deletion_verified_at is not null),
  check (retention_expires_at > created_at and retention_expires_at <= created_at + interval '30 days'),
  check (browser_execution_id is null or step_id is not null),
  foreign key (browser_execution_id, step_id, workspace_id)
    references public.browser_executions(id, step_id, workspace_id) on delete cascade,
  foreign key (step_id, workspace_id)
    references public.workflow_steps(id, workspace_id) on delete cascade
);

create table app_private.artifact_locations (
  artifact_id uuid primary key,
  workspace_id uuid not null,
  bucket_id text not null check (bucket_id in ('openinstinct-quarantine','openinstinct-artifacts')),
  storage_key text not null unique check (char_length(storage_key) between 10 and 500),
  provider_remote_path text check (provider_remote_path is null or char_length(provider_remote_path) between 1 and 1000),
  etag text check (etag is null or char_length(etag) between 1 and 500),
  created_at timestamptz not null default now(),
  foreign key (artifact_id, workspace_id)
    references public.artifacts(id, workspace_id) on delete cascade
);

create table app_private.artifact_ingest_leases (
  artifact_id uuid primary key,
  workspace_id uuid not null,
  lease_token_hash text not null check (lease_token_hash ~ '^[0-9a-f]{64}$'),
  lease_expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  foreign key (artifact_id, workspace_id)
    references public.artifacts(id, workspace_id) on delete cascade
);

create table app_private.worker_heartbeats (
  worker_id text primary key check (char_length(worker_id) between 1 and 200),
  last_seen_at timestamptz not null,
  last_poll_at timestamptz not null,
  jobs_processed bigint not null default 0 check (jobs_processed >= 0),
  oldest_queue_latency_ms bigint not null default 0 check (oldest_queue_latency_ms >= 0)
);

create table public.site_support (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  exact_origin text not null check (
    exact_origin ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$'
    and char_length(exact_origin) <= 500
  ),
  read_only_status text not null check (read_only_status in (
    'supported','best_effort','handoff_required','unsupported'
  )),
  provider text not null check (char_length(provider) between 1 and 64),
  provider_version text check (provider_version is null or char_length(provider_version) between 1 and 100),
  canary_hash text check (canary_hash is null or canary_hash ~ '^[0-9a-f]{64}$'),
  checked_at timestamptz,
  expires_at timestamptz,
  last_error_code text check (last_error_code is null or char_length(last_error_code) between 1 and 128),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, exact_origin, provider)
);

do $$
declare
  policy_row record;
  normalized_using text;
  normalized_check text;
  safe_using boolean;
  safe_check boolean;
begin
  for policy_row in
    select policyname,cmd,qual,with_check from pg_policies
    where schemaname='storage' and tablename='objects'
      and exists (
        select 1 from unnest(roles) policy_role
        where policy_role='public'
          or pg_has_role('anon',policy_role,'member')
          or pg_has_role('authenticated',policy_role,'member')
      )
  loop
    normalized_using := regexp_replace(
      replace(lower(coalesce(policy_row.qual,'')),'::text',''),
      '[[:space:]()]','','g'
    );
    normalized_check := regexp_replace(
      replace(lower(coalesce(policy_row.with_check,'')),'::text',''),
      '[[:space:]()]','','g'
    );
    if policy_row.cmd in ('UPDATE','ALL') and policy_row.with_check is null then
      normalized_check := normalized_using;
    end if;
    safe_using := normalized_using ~ '^bucket_id=''[a-z0-9._-]+''$'
      or normalized_using ~ '^''[a-z0-9._-]+''=bucket_id$';
    safe_check := normalized_check ~ '^bucket_id=''[a-z0-9._-]+''$'
      or normalized_check ~ '^''[a-z0-9._-]+''=bucket_id$';
    if normalized_using ~ 'openinstinct-(quarantine|artifacts)'
      or normalized_check ~ 'openinstinct-(quarantine|artifacts)'
      or (policy_row.cmd in ('SELECT','DELETE') and not safe_using)
      or (policy_row.cmd='INSERT' and not safe_check)
      or (policy_row.cmd in ('UPDATE','ALL') and (not safe_using or not safe_check))
    then
      raise exception 'storage.objects policy % is not a provably unrelated exact-bucket policy', policy_row.policyname
        using errcode='55000';
    end if;
  end loop;
end;
$$;

create trigger browser_executions_updated before update on public.browser_executions
for each row execute function app_private.set_updated_at();
create trigger browser_execution_handles_updated before update on app_private.browser_execution_handles
for each row execute function app_private.set_updated_at();
create trigger site_support_updated before update on public.site_support
for each row execute function app_private.set_updated_at();

create function app_private.enforce_browser_artifact_count()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.browser_execution_id is null then return new; end if;
  perform 1 from public.browser_executions
    where id=new.browser_execution_id and workspace_id=new.workspace_id for update;
  if (select count(*) from public.artifacts
      where browser_execution_id=new.browser_execution_id and workspace_id=new.workspace_id) >= 50 then
    raise exception 'browser execution artifact count limit exceeded' using errcode='23514';
  end if;
  return new;
end;
$$;
revoke all on function app_private.enforce_browser_artifact_count()
from public, anon, authenticated;
create trigger artifacts_count_limit before insert on public.artifacts
for each row execute function app_private.enforce_browser_artifact_count();

create unique index browser_executions_one_profile_owner_idx
on public.browser_executions (profile_id)
where profile_id is not null and status in (
  'queued','running','waiting_owner','cleanup_pending'
);
create unique index browser_executions_one_active_run_idx
on public.browser_executions (run_id)
where status in ('queued','running','waiting_owner','cleanup_pending');
create index browser_executions_recovery_idx
on public.browser_executions (status, updated_at)
where status in ('queued','running','cleanup_pending');
create index browser_executions_run_workspace_fk_idx
on public.browser_executions (run_id, workspace_id);
create index browser_executions_profile_workspace_fk_idx
on public.browser_executions (profile_id, workspace_id);
create index browser_handoffs_execution_workspace_fk_idx
on public.browser_handoffs (execution_id, workspace_id);
create index browser_handoffs_expiry_idx
on public.browser_handoffs (expires_at)
where status in ('requested','active');
create unique index browser_handoffs_one_active_execution_idx
on public.browser_handoffs (execution_id)
where status in ('requested','active');
create index browser_execution_handles_lease_idx
on app_private.browser_execution_handles (lease_expires_at)
where lease_token_hash is not null;
create index browser_execution_slices_claim_idx
on app_private.browser_execution_slices (status, created_at)
where status in ('queued','claimed');
create index artifacts_cleanup_idx on public.artifacts (state, deletion_requested_at)
where state in ('quarantined','scanning','deletion_pending','deletion_unknown');
create index artifact_ingest_leases_expiry_idx
on app_private.artifact_ingest_leases (lease_expires_at);
create index artifacts_execution_idx on public.artifacts (browser_execution_id, created_at);
create index artifacts_execution_step_workspace_fk_idx
on public.artifacts (browser_execution_id, step_id, workspace_id);
create index artifacts_step_fk_idx on public.artifacts (step_id, workspace_id);

alter table public.browser_executions enable row level security;
alter table public.browser_handoffs enable row level security;
alter table public.artifacts enable row level security;
alter table public.site_support enable row level security;

create policy browser_executions_select_owner on public.browser_executions
for select to authenticated using (exists (
  select 1 from public.workspaces w
  where w.id = workspace_id and w.owner_user_id = (select auth.uid())
));
create policy artifacts_select_owner on public.artifacts
for select to authenticated using (exists (
  select 1 from public.workspaces w
  where w.id = workspace_id and w.owner_user_id = (select auth.uid())
));
create policy browser_handoffs_select_owner on public.browser_handoffs
for select to authenticated using (exists (
  select 1 from public.workspaces w
  where w.id = workspace_id and w.owner_user_id = (select auth.uid())
));
create policy site_support_select_owner on public.site_support
for select to authenticated using (exists (
  select 1 from public.workspaces w
  where w.id = workspace_id and w.owner_user_id = (select auth.uid())
));

revoke all on public.browser_executions, public.browser_handoffs,
  public.artifacts, public.site_support
from public, anon, authenticated;
grant select (
  id, workspace_id, run_id, step_id, profile_id, profile_configuration_version,
  mode, status, goal_hash,
  policy_hash, max_steps, steps_completed, max_duration_seconds,
  max_cost_units, cost_units_used,
  last_error_code, started_at, completed_at, created_at, updated_at
) on public.browser_executions to authenticated;
grant select (
  id, workspace_id, execution_id, status, reason_code, expires_at,
  first_accessed_at, completed_at, created_at
) on public.browser_handoffs to authenticated;
grant select (
  id, workspace_id, browser_execution_id, step_id, kind, sensitivity, state,
  display_name, declared_mime_type, detected_mime_type, size_bytes, sha256,
  scan_verdict, scan_version, scan_code, redaction_status, redaction_version,
  created_at, available_at,
  deletion_requested_at, deletion_verified_at, retention_expires_at
) on public.artifacts to authenticated;
grant select on public.site_support to authenticated;
revoke all on app_private.browser_execution_handles,
  app_private.browser_execution_slices, app_private.browser_handoff_handles,
  app_private.artifact_locations, app_private.artifact_ingest_leases
from public, anon, authenticated, service_role;
revoke all on app_private.worker_heartbeats
from public, anon, authenticated, service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('openinstinct-quarantine','openinstinct-quarantine',false,25000000,null),
  ('openinstinct-artifacts','openinstinct-artifacts',false,25000000,null)
on conflict (id) do update set
  public = false,
  file_size_limit = least(storage.buckets.file_size_limit, excluded.file_size_limit),
  allowed_mime_types = null;

comment on table app_private.browser_execution_handles is
  'Fenced provider lifecycle and lease state. Provider IDs, URLs, goals, and exact origins are never exposed through the Data API.';
comment on table app_private.browser_execution_slices is
  'One durable observe/decide/action slice. Contains redacted semantic observations only; never raw HTML, screenshots, cookies, or input values.';
comment on table app_private.artifact_locations is
  'Private byte-store and provider paths. Public artifact rows contain metadata only.';

create or replace function app_private.purge_workspace_execution_history(target_workspace_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() <> 'service_role' and current_user not in ('postgres', 'supabase_admin') then
    raise exception 'workspace purge requires the trusted server role' using errcode = '42501';
  end if;
  if exists (select 1 from public.browser_profiles where workspace_id = target_workspace_id) then
    raise exception 'provider browser profiles must be verifiably deleted before workspace purge'
      using errcode = '55000';
  end if;
  if exists (
    select 1 from public.browser_executions
    where workspace_id = target_workspace_id
      and status not in ('completed','failed','unknown','cancelled')
  ) then
    raise exception 'browser executions must reach a verified terminal state before workspace purge'
      using errcode = '55000';
  end if;
  if exists (
    select 1 from public.artifacts
    where workspace_id = target_workspace_id
      and (state <> 'deleted' or deletion_recheck_until>now())
  ) then
    raise exception 'artifact bytes and late-write tombstones must be verifiably cleared before workspace purge'
      using errcode = '55000';
  end if;
  if exists (
    select 1 from app_private.artifact_locations
    where workspace_id = target_workspace_id
  ) then
    raise exception 'artifact byte locations must be removed before workspace purge'
      using errcode = '55000';
  end if;
  perform set_config('app_private.execution_history_purge_workspace', target_workspace_id::text, true);
  delete from public.artifacts where workspace_id = target_workspace_id;
  delete from public.browser_executions where workspace_id = target_workspace_id;
  delete from public.site_support where workspace_id = target_workspace_id;
  delete from public.run_events where workspace_id = target_workspace_id;
  delete from public.audit_events where workspace_id = target_workspace_id;
  delete from public.tool_results where workspace_id = target_workspace_id and reconciles_result_id is not null;
  delete from public.tool_results where workspace_id = target_workspace_id;
  delete from public.workspaces where id = target_workspace_id;
end;
$$;
