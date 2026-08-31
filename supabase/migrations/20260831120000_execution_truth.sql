-- Phase 0: durable execution truth. All changes are additive.

create unique index agent_runs_id_workspace_idx
on public.agent_runs (id, workspace_id);

create unique index action_requests_id_workspace_idx
on public.action_requests (id, workspace_id);
create unique index action_requests_id_run_workspace_idx
on public.action_requests (id, run_id, workspace_id);

do $$
begin
  if exists (
    select 1 from public.action_requests a
    join public.agent_runs r on r.id = a.run_id
    where a.workspace_id <> r.workspace_id
  ) or exists (
    select 1 from public.approvals p
    join public.action_requests a on a.id = p.action_request_id
    where p.workspace_id <> a.workspace_id
  ) then
    raise exception 'execution truth migration blocked: repair legacy cross-workspace action lineage before retrying';
  end if;
  if exists (
    select 1 from public.action_requests
    where input_hash !~ '^[0-9a-f]{64}$'
       or jsonb_typeof(input) <> 'object'
       or octet_length(input::text) > 128000
       or char_length(tool_name) not between 1 and 256
       or char_length(summary) not between 1 and 4000
  ) or exists (
    select 1 from public.approvals
    where input_hash !~ '^[0-9a-f]{64}$'
  ) then
    raise exception 'execution truth migration blocked: normalize legacy action bounds or hashes before retrying';
  end if;
end;
$$;

alter table public.action_requests
  add constraint action_requests_run_workspace_fk
    foreign key (run_id, workspace_id)
      references public.agent_runs(id, workspace_id) on delete cascade,
  add constraint action_requests_input_bounds
    check (jsonb_typeof(input) = 'object' and octet_length(input::text) <= 128000),
  add constraint action_requests_tool_name_bounds
    check (char_length(tool_name) between 1 and 256),
  add constraint action_requests_summary_bounds
    check (char_length(summary) between 1 and 4000);
alter table public.approvals
  add constraint approvals_action_workspace_fk
    foreign key (action_request_id, workspace_id)
      references public.action_requests(id, workspace_id) on delete cascade;

alter table public.agent_runs
  add column claim_token uuid,
  add column lease_expires_at timestamptz,
  add constraint agent_runs_claim_lease_pair
    check ((claim_token is null) = (lease_expires_at is null));

create index agent_runs_stale_claim_idx
on public.agent_runs (lease_expires_at)
where status = 'running';

do $$
begin
  if exists (
    select 1 from public.action_requests
    where status in ('pending', 'approved', 'executing', 'unknown')
    group by run_id having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'execution truth migration blocked: reconcile legacy runs with multiple unresolved actions before retrying';
  end if;
end;
$$;

drop index public.action_requests_one_active_per_run_idx;
create unique index action_requests_one_unresolved_per_run_idx
on public.action_requests (run_id)
where status in ('pending', 'approved', 'executing', 'unknown');

alter table public.action_requests
  add constraint action_requests_input_hash_format
    check (input_hash ~ '^[0-9a-f]{64}$');
alter table public.approvals
  add constraint approvals_input_hash_format
    check (input_hash ~ '^[0-9a-f]{64}$');

create table public.workflow_steps (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid not null,
  action_request_id uuid,
  position integer not null check (position >= 0),
  kind text not null check (kind in ('tool', 'action', 'continuation', 'reconciliation')),
  tool_name text check (tool_name is null or char_length(tool_name) between 1 and 256),
  status text not null default 'planned'
    check (status in ('planned', 'waiting_approval', 'running', 'succeeded', 'failed', 'unknown', 'cancelled')),
  execution_phase text
    check (execution_phase is null or execution_phase in ('claimed', 'invocation_started', 'result_received', 'result_persisted')),
  input jsonb not null default '{}'::jsonb
    check (jsonb_typeof(input) = 'object' and octet_length(input::text) <= 128000),
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  attempt integer not null default 0 check (attempt >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, position),
  unique (action_request_id),
  unique (id, workspace_id),
  unique (id, run_id, workspace_id),
  check (attempt <= max_attempts),
  foreign key (run_id, workspace_id)
    references public.agent_runs(id, workspace_id) on delete cascade,
  foreign key (action_request_id, workspace_id)
    references public.action_requests(id, workspace_id) on delete cascade,
  foreign key (action_request_id, run_id, workspace_id)
    references public.action_requests(id, run_id, workspace_id) on delete cascade
);

create table public.tool_results (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid not null,
  step_id uuid not null,
  action_request_id uuid,
  reconciles_result_id uuid,
  tool_name text not null check (char_length(tool_name) between 1 and 256),
  certainty text not null check (certainty in (
    'succeeded',
    'failed_before_effect',
    'failed_after_reversible_effect',
    'unknown',
    'reconciled_succeeded',
    'reconciled_failed'
  )),
  attempt integer not null check (attempt > 0),
  output jsonb check (output is null or octet_length(output::text) <= 128000),
  output_hash text check (output_hash is null or output_hash ~ '^[0-9a-f]{64}$'),
  error_code text check (error_code is null or char_length(error_code) between 1 and 128),
  error_message text check (error_message is null or char_length(error_message) between 1 and 2000),
  retry_eligible boolean not null default false,
  result_hash text not null check (result_hash ~ '^[0-9a-f]{64}$'),
  continuation_status text not null default 'pending'
    check (continuation_status in ('pending', 'enqueued')),
  continuation_enqueued_at timestamptz,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (action_request_id),
  unique (step_id, attempt),
  unique (id, workspace_id),
  unique (id, run_id, workspace_id),
  unique (reconciles_result_id),
  check ((output is null and output_hash is null) or (output is not null and output_hash is not null)),
  check (completed_at >= started_at),
  check (not retry_eligible or certainty = 'failed_before_effect'),
  check (
    (certainty in ('reconciled_succeeded', 'reconciled_failed'))
      = (reconciles_result_id is not null)
  ),
  check (
    (continuation_status = 'pending' and continuation_enqueued_at is null)
    or (continuation_status = 'enqueued' and continuation_enqueued_at is not null)
  ),
  foreign key (run_id, workspace_id)
    references public.agent_runs(id, workspace_id) on delete cascade,
  foreign key (step_id, workspace_id)
    references public.workflow_steps(id, workspace_id) on delete cascade,
  foreign key (step_id, run_id, workspace_id)
    references public.workflow_steps(id, run_id, workspace_id) on delete cascade,
  foreign key (action_request_id, workspace_id)
    references public.action_requests(id, workspace_id) on delete cascade,
  foreign key (action_request_id, run_id, workspace_id)
    references public.action_requests(id, run_id, workspace_id) on delete cascade,
  foreign key (reconciles_result_id, run_id, workspace_id)
    references public.tool_results(id, run_id, workspace_id) on delete restrict
);

create function app_private.validate_result_reconciliation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  referenced_certainty text;
begin
  if new.reconciles_result_id is null then
    return new;
  end if;
  if new.action_request_id is not null then
    raise exception 'reconciliation results cannot claim a new action request' using errcode = '23514';
  end if;
  select certainty into referenced_certainty
  from public.tool_results where id = new.reconciles_result_id;
  if referenced_certainty is distinct from 'unknown' then
    raise exception 'reconciliation must reference an unknown result' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function app_private.validate_result_reconciliation() from public, anon, authenticated;

create trigger tool_results_validate_reconciliation
before insert on public.tool_results
for each row execute function app_private.validate_result_reconciliation();

create table public.run_events (
  id uuid primary key default gen_random_uuid(),
  sequence bigint generated always as identity unique,
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  run_id uuid not null,
  step_id uuid,
  action_request_id uuid,
  tool_result_id uuid,
  event_type text not null check (event_type in (
    'run_created',
    'run_started',
    'run_completed',
    'run_failed',
    'run_cancelled',
    'action_proposed',
    'approval_decided',
    'action_execution_claimed',
    'action_invocation_started',
    'action_result_received',
    'action_retry_scheduled',
    'tool_result_recorded',
    'continuation_enqueued'
  )),
  event_key text not null check (char_length(event_key) between 1 and 500),
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 64000),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (run_id, event_key),
  foreign key (run_id, workspace_id)
    references public.agent_runs(id, workspace_id) on delete restrict,
  foreign key (step_id, workspace_id)
    references public.workflow_steps(id, workspace_id) on delete restrict,
  foreign key (step_id, run_id, workspace_id)
    references public.workflow_steps(id, run_id, workspace_id) on delete restrict,
  foreign key (action_request_id, workspace_id)
    references public.action_requests(id, workspace_id) on delete restrict,
  foreign key (action_request_id, run_id, workspace_id)
    references public.action_requests(id, run_id, workspace_id) on delete restrict,
  foreign key (tool_result_id, workspace_id)
    references public.tool_results(id, workspace_id) on delete restrict,
  foreign key (tool_result_id, run_id, workspace_id)
    references public.tool_results(id, run_id, workspace_id) on delete restrict
);

create index workflow_steps_claimable_idx
on public.workflow_steps (run_id, status, position)
where status in ('planned', 'waiting_approval', 'running');
create index tool_results_run_created_idx
on public.tool_results (run_id, created_at);
create index tool_results_pending_continuation_idx
on public.tool_results (run_id, created_at)
where continuation_status = 'pending';
create index run_events_run_created_idx
on public.run_events (run_id, sequence);
create index run_events_step_idx on public.run_events (step_id);
create index run_events_action_idx on public.run_events (action_request_id);
create index run_events_result_idx on public.run_events (tool_result_id);
create index action_requests_run_all_idx on public.action_requests (run_id);

create trigger workflow_steps_updated
before update on public.workflow_steps
for each row execute function app_private.set_updated_at();

create function app_private.reject_append_only_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_setting('app_private.execution_history_purge_workspace', true)
      = old.workspace_id::text then
    return old;
  end if;
  raise exception '% is append-only', tg_table_name using errcode = '55000';
end;
$$;
revoke all on function app_private.reject_append_only_change() from public, anon, authenticated;

create trigger run_events_append_only
before update or delete on public.run_events
for each row execute function app_private.reject_append_only_change();

alter table public.audit_events
  add column run_id uuid,
  add column workflow_step_id uuid,
  add column action_request_id uuid,
  add column event_key text,
  add column detail_hash text;

update public.audit_events
set detail = jsonb_build_object(
  'legacyDetailOmitted', true,
  'originalHash', encode(extensions.digest(detail::text, 'sha256'), 'hex')
)
where jsonb_typeof(detail) <> 'object'
   or octet_length(detail::text) > 64000;

update public.audit_events
set event_key = 'legacy:' || id::text,
    detail_hash = encode(extensions.digest(detail::text, 'sha256'), 'hex');

alter table public.audit_events
  alter column event_key set not null,
  alter column detail_hash set not null,
  add constraint audit_events_event_key_bounds
    check (char_length(event_key) between 1 and 500),
  add constraint audit_events_detail_hash_length
    check (detail_hash ~ '^[0-9a-f]{64}$'),
  add constraint audit_events_detail_bounds
    check (jsonb_typeof(detail) = 'object' and octet_length(detail::text) <= 64000),
  add constraint audit_events_step_requires_run
    check (workflow_step_id is null or run_id is not null),
  add constraint audit_events_action_requires_run
    check (action_request_id is null or run_id is not null),
  add constraint audit_events_workspace_event_key_unique
    unique (workspace_id, event_key),
  add constraint audit_events_run_workspace_fk
    foreign key (run_id, workspace_id)
      references public.agent_runs(id, workspace_id) on delete restrict,
  add constraint audit_events_step_run_workspace_fk
    foreign key (workflow_step_id, run_id, workspace_id)
      references public.workflow_steps(id, run_id, workspace_id) on delete restrict,
  add constraint audit_events_action_run_workspace_fk
    foreign key (action_request_id, run_id, workspace_id)
      references public.action_requests(id, run_id, workspace_id) on delete restrict;

create index audit_events_run_created_idx
on public.audit_events (run_id, created_at);
create index audit_events_step_idx on public.audit_events (workflow_step_id);
create index audit_events_action_idx on public.audit_events (action_request_id);

create trigger audit_events_append_only
before update or delete on public.audit_events
for each row execute function app_private.reject_append_only_change();

create function app_private.purge_workspace_execution_history(target_workspace_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' and current_user not in ('postgres', 'supabase_admin') then
    raise exception 'workspace purge requires the trusted server role' using errcode = '42501';
  end if;
  perform set_config(
    'app_private.execution_history_purge_workspace',
    target_workspace_id::text,
    true
  );
  delete from public.run_events where workspace_id = target_workspace_id;
  delete from public.audit_events where workspace_id = target_workspace_id;
  delete from public.tool_results
  where workspace_id = target_workspace_id and reconciles_result_id is not null;
  delete from public.tool_results where workspace_id = target_workspace_id;
  delete from public.workspaces where id = target_workspace_id;
end;
$$;
revoke all on function app_private.purge_workspace_execution_history(uuid)
from public, anon, authenticated;
grant usage on schema app_private to service_role;
grant execute on function app_private.purge_workspace_execution_history(uuid)
to service_role;

alter table public.workflow_steps enable row level security;
alter table public.tool_results enable row level security;
alter table public.run_events enable row level security;

revoke all on public.workflow_steps, public.tool_results, public.run_events from anon, authenticated;
grant select on public.workflow_steps, public.run_events to authenticated;
grant select (
  id, workspace_id, run_id, step_id, action_request_id,
  reconciles_result_id, tool_name, certainty, attempt, output_hash,
  error_code, retry_eligible, started_at, completed_at, created_at
) on public.tool_results to authenticated;

create view public.tool_result_summaries
with (security_invoker = true)
as select
  id, workspace_id, run_id, step_id, action_request_id,
  reconciles_result_id, tool_name, certainty, attempt, output_hash,
  error_code, retry_eligible, started_at, completed_at, created_at
from public.tool_results;
revoke all on public.tool_result_summaries from public, anon, authenticated;
grant select on public.tool_result_summaries to authenticated;

create policy workflow_steps_select_owner on public.workflow_steps
for select to authenticated
using (exists (
  select 1 from public.workspaces w
  where w.id = workspace_id and w.owner_user_id = (select auth.uid())
));

create policy tool_results_select_owner on public.tool_results
for select to authenticated
using (exists (
  select 1 from public.workspaces w
  where w.id = workspace_id and w.owner_user_id = (select auth.uid())
));

create policy run_events_select_owner on public.run_events
for select to authenticated
using (exists (
  select 1 from public.workspaces w
  where w.id = workspace_id and w.owner_user_id = (select auth.uid())
));

comment on table public.run_events is
  'Append-only, bounded execution history. Payloads contain normalized metadata, never raw provider bodies or secrets.';
comment on table public.tool_results is
  'Structured execution outcomes. Only failed_before_effect is retry eligible; pending continuation rows form a durable outbox.';
