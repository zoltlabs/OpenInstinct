-- Phase 3: semantic authorization and resumable low-risk writes.

alter table public.action_requests
  add column semantic_intent jsonb,
  add column semantic_intent_hash text,
  add column guard_conditions jsonb,
  add column guard_conditions_hash text,
  add column authority_grant_id uuid,
  add constraint action_requests_semantic_bundle check (
    (semantic_intent is null and semantic_intent_hash is null and
      guard_conditions is null and guard_conditions_hash is null and
      authority_grant_id is null)
    or
    (semantic_intent is not null and semantic_intent_hash is not null and
      guard_conditions is not null and guard_conditions_hash is not null and
      jsonb_typeof(semantic_intent) = 'object' and
      octet_length(semantic_intent::text) <= 64000 and
      semantic_intent_hash ~ '^[0-9a-f]{64}$' and
      jsonb_typeof(guard_conditions) = 'object' and
      octet_length(guard_conditions::text) <= 64000 and
      guard_conditions_hash ~ '^[0-9a-f]{64}$')
  );

alter table public.approvals
  add column semantic_intent_hash text,
  add column guard_conditions_hash text,
  add column authority_grant_id uuid,
  add column typed_confirmation boolean not null default false,
  add constraint approvals_semantic_hash_bundle check (
    (semantic_intent_hash is null and guard_conditions_hash is null and
      authority_grant_id is null)
    or (semantic_intent_hash is not null and guard_conditions_hash is not null and
        semantic_intent_hash ~ '^[0-9a-f]{64}$' and
        guard_conditions_hash ~ '^[0-9a-f]{64}$')
  );

create function app_private.protect_action_authority_snapshot()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.tool_name is distinct from old.tool_name
     or new.risk is distinct from old.risk
     or new.summary is distinct from old.summary
     or new.input is distinct from old.input
     or new.input_hash is distinct from old.input_hash
     or new.semantic_intent is distinct from old.semantic_intent
     or new.semantic_intent_hash is distinct from old.semantic_intent_hash
     or new.guard_conditions is distinct from old.guard_conditions
     or new.guard_conditions_hash is distinct from old.guard_conditions_hash
     or new.authority_grant_id is distinct from old.authority_grant_id then
    raise exception 'action authority snapshot is immutable' using errcode = '55000';
  end if;
  return new;
end;
$$;
revoke all on function app_private.protect_action_authority_snapshot()
from public, anon, authenticated;
create trigger action_requests_protect_authority_snapshot
before update on public.action_requests
for each row execute function app_private.protect_action_authority_snapshot();

create function app_private.validate_semantic_approval()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  action_intent_hash text;
  action_guard_hash text;
  action_grant_id uuid;
  action_risk text;
  action_effect text;
begin
  select semantic_intent_hash, guard_conditions_hash, authority_grant_id, risk,
    semantic_intent->>'effect'
    into action_intent_hash, action_guard_hash, action_grant_id, action_risk,
      action_effect
  from public.action_requests
  where id = new.action_request_id and workspace_id = new.workspace_id;
  if (action_intent_hash is not null or action_guard_hash is not null or
      action_grant_id is not null) and
     (new.semantic_intent_hash is distinct from action_intent_hash or
      new.guard_conditions_hash is distinct from action_guard_hash or
      new.authority_grant_id is distinct from action_grant_id) then
    raise exception 'approval semantic binding mismatch' using errcode = '23514';
  end if;
  if new.approved and
     (action_risk = 'destructive' or action_effect in ('delete','cancel')) and
     not new.typed_confirmation then
    raise exception 'destructive approval requires typed confirmation' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function app_private.validate_semantic_approval()
from public, anon, authenticated;
create trigger approvals_validate_semantic_binding
before insert on public.approvals
for each row execute function app_private.validate_semantic_approval();
create trigger approvals_append_only
before update or delete on public.approvals
for each row execute function app_private.reject_append_only_change();

create table public.authority_grants (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  version integer not null default 1 check (version > 0),
  name text not null check (char_length(name) between 1 and 200),
  effects text[] not null check (
    cardinality(effects) between 1 and 8 and
    effects <@ array['read','create','update','send','cancel','delete','purchase','security_change']::text[]
  ),
  resource_classes text[] not null check (cardinality(resource_classes) between 1 and 50),
  providers text[] not null check (cardinality(providers) between 1 and 50),
  origins text[] not null default '{}',
  account_ids text[] not null default '{}',
  counterparty_ids text[] not null default '{}',
  recipient_ids text[] not null default '{}',
  per_action_limit jsonb,
  rolling_limit jsonb,
  max_uses integer check (max_uses is null or max_uses > 0),
  minimum_interval_seconds integer not null default 0
    check (minimum_interval_seconds between 0 and 31557600),
  quiet_hours jsonb,
  starts_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  always_require_fresh_approval boolean not null default false,
  always_require_human_takeover boolean not null default false,
  configuration_version text not null check (configuration_version ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  check (expires_at > starts_at),
  check (octet_length(coalesce(per_action_limit, '{}'::jsonb)::text) <= 1000),
  check (octet_length(coalesce(rolling_limit, '{}'::jsonb)::text) <= 2000),
  check (octet_length(coalesce(quiet_hours, '{}'::jsonb)::text) <= 1000),
  check (not effects && array['purchase','security_change','delete','cancel']::text[]),
  check (not ('send' = any(effects)) or cardinality(recipient_ids) > 0),
  check (cardinality(origins) <= 50 and cardinality(account_ids) <= 50 and
    cardinality(counterparty_ids) <= 100 and cardinality(recipient_ids) <= 100)
);
create index authority_grants_active_idx
on public.authority_grants (workspace_id, expires_at)
where revoked_at is null;
create trigger authority_grants_updated before update on public.authority_grants
for each row execute function app_private.set_updated_at();
create function app_private.protect_authority_grant_version()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if (to_jsonb(new) - array['revoked_at','updated_at'])
      is distinct from
     (to_jsonb(old) - array['revoked_at','updated_at']) then
    raise exception 'authority grant versions are immutable' using errcode = '55000';
  end if;
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'authority grant revocation is irreversible' using errcode = '55000';
  end if;
  return new;
end;
$$;
revoke all on function app_private.protect_authority_grant_version()
from public, anon, authenticated;
create trigger authority_grants_protect_version
before update on public.authority_grants
for each row execute function app_private.protect_authority_grant_version();

alter table public.action_requests
  add constraint action_requests_authority_grant_workspace_fk
  foreign key (authority_grant_id, workspace_id)
  references public.authority_grants(id, workspace_id) on delete restrict;
alter table public.approvals
  add constraint approvals_authority_grant_workspace_fk
  foreign key (authority_grant_id, workspace_id)
  references public.authority_grants(id, workspace_id) on delete restrict;

create table public.authority_usages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  grant_id uuid not null,
  action_request_id uuid not null,
  grant_configuration_version text not null check (grant_configuration_version ~ '^[0-9a-f]{64}$'),
  semantic_intent_hash text not null check (semantic_intent_hash ~ '^[0-9a-f]{64}$'),
  guard_conditions_hash text not null check (guard_conditions_hash ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('reserved','committed','released','unknown')),
  amount jsonb,
  reserved_at timestamptz not null default now(),
  terminal_at timestamptz,
  created_at timestamptz not null default now(),
  unique (action_request_id),
  unique (id, workspace_id),
  foreign key (grant_id, workspace_id)
    references public.authority_grants(id, workspace_id) on delete restrict,
  foreign key (action_request_id, workspace_id)
    references public.action_requests(id, workspace_id) on delete restrict,
  check ((status = 'reserved') = (terminal_at is null)),
  check (amount is null or (jsonb_typeof(amount) = 'object' and octet_length(amount::text) <= 1000))
);
create function app_private.protect_authority_usage()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('app_private.execution_history_purge_workspace', true)
        = old.workspace_id::text then return old; end if;
    raise exception 'authority usage is durable execution history' using errcode = '55000';
  end if;
  if new.workspace_id is distinct from old.workspace_id
     or new.grant_id is distinct from old.grant_id
     or new.action_request_id is distinct from old.action_request_id
     or new.grant_configuration_version is distinct from old.grant_configuration_version
     or new.semantic_intent_hash is distinct from old.semantic_intent_hash
     or new.guard_conditions_hash is distinct from old.guard_conditions_hash
     or new.amount is distinct from old.amount
     or new.reserved_at is distinct from old.reserved_at
     or new.created_at is distinct from old.created_at
     or not (
       (old.status = 'reserved' and new.status in ('committed','released','unknown'))
       or (old.status = 'unknown' and new.status in ('committed','released'))
     )
     or new.terminal_at is null then
    raise exception 'invalid authority usage transition' using errcode = '55000';
  end if;
  return new;
end;
$$;
revoke all on function app_private.protect_authority_usage()
from public, anon, authenticated;
create trigger authority_usages_protect
before update or delete on public.authority_usages
for each row execute function app_private.protect_authority_usage();
create index authority_usages_grant_window_idx
on public.authority_usages (grant_id, reserved_at)
where status in ('reserved','committed','unknown');

create unique index workflow_steps_id_action_run_workspace_idx
on public.workflow_steps (id, action_request_id, run_id, workspace_id);
with sanitized as (
  select s.id,
    jsonb_build_object(
      'caseId', s.id::text,
      'unknownResultId', coalesce(r.reconciles_result_id::text, s.id::text),
      'evidenceHash', encode(extensions.digest(s.input::text, 'sha256'), 'hex'),
      'safeSummary', 'Legacy reconciliation evidence was removed during the semantic authority upgrade.'
    ) as safe_input
  from public.workflow_steps s
  left join public.tool_results r on r.step_id = s.id
    and r.run_id = s.run_id and r.workspace_id = s.workspace_id
  where s.kind = 'reconciliation'
)
update public.workflow_steps s
set input = sanitized.safe_input,
  input_hash = encode(extensions.digest(sanitized.safe_input::text, 'sha256'), 'hex')
from sanitized where s.id = sanitized.id;
alter table public.workflow_steps
  add constraint workflow_steps_reconciliation_input_is_safe check (
    kind <> 'reconciliation' or (
      jsonb_typeof(input) = 'object' and
      input ?& array['caseId','unknownResultId','evidenceHash','safeSummary'] and
      not (input ?| array['evidence','facts','payload','redactedFacts']) and
      input - array['caseId','unknownResultId','evidenceHash','safeSummary'] = '{}'::jsonb and
      input->>'caseId' ~ '^[0-9a-f-]{36}$' and
      input->>'unknownResultId' ~ '^[0-9a-f-]{36}$' and
      input->>'evidenceHash' ~ '^[0-9a-f]{64}$' and
      char_length(input->>'safeSummary') between 1 and 500
    )
  );

create table public.action_evidence (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid not null,
  action_request_id uuid not null,
  workflow_step_id uuid not null,
  tool_result_id uuid,
  phase text not null check (phase in ('before_commit','commit_response','postcondition','reconciliation')),
  outcome text not null check (outcome in ('observed','not_observed','inconclusive')),
  verifier text not null check (char_length(verifier) between 1 and 128),
  verifier_version integer not null check (verifier_version > 0),
  evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
  safe_summary text check (safe_summary is null or char_length(safe_summary) <= 1000),
  captured_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (run_id, workspace_id)
    references public.agent_runs(id, workspace_id) on delete restrict,
  foreign key (action_request_id, run_id, workspace_id)
    references public.action_requests(id, run_id, workspace_id) on delete restrict,
  foreign key (workflow_step_id, run_id, workspace_id)
    references public.workflow_steps(id, run_id, workspace_id) on delete restrict,
  foreign key (tool_result_id, run_id, workspace_id)
    references public.tool_results(id, run_id, workspace_id) on delete restrict
);
create function app_private.validate_action_evidence_lineage()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.phase <> 'reconciliation' and not exists (
    select 1 from public.workflow_steps s
    where s.id = new.workflow_step_id and s.run_id = new.run_id
      and s.workspace_id = new.workspace_id
      and s.action_request_id = new.action_request_id
  ) then
    raise exception 'action evidence step lineage mismatch' using errcode = '23514';
  end if;
  if new.phase = 'reconciliation' and not exists (
    select 1
    from public.tool_results reconciled
    join public.tool_results original on original.id = reconciled.reconciles_result_id
    where reconciled.id = new.tool_result_id
      and reconciled.step_id = new.workflow_step_id
      and reconciled.run_id = new.run_id
      and reconciled.workspace_id = new.workspace_id
      and original.action_request_id = new.action_request_id
  ) then
    raise exception 'reconciliation evidence lineage mismatch' using errcode = '23514';
  end if;
  if new.tool_result_id is not null and not exists (
    select 1 from public.tool_results r
    where r.id = new.tool_result_id and r.run_id = new.run_id
      and r.workspace_id = new.workspace_id
      and (
        r.action_request_id = new.action_request_id
        or (new.phase = 'reconciliation' and exists (
          select 1 from public.tool_results original
          where original.id = r.reconciles_result_id
            and original.action_request_id = new.action_request_id
        ))
      )
  ) then
    raise exception 'action evidence result lineage mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function app_private.validate_action_evidence_lineage()
from public, anon, authenticated;
create trigger action_evidence_validate_lineage before insert on public.action_evidence
for each row execute function app_private.validate_action_evidence_lineage();
create index action_evidence_action_idx on public.action_evidence (action_request_id, captured_at);
create trigger action_evidence_append_only before update or delete on public.action_evidence
for each row execute function app_private.reject_append_only_change();

create table app_private.action_evidence_payloads (
  evidence_id uuid not null,
  workspace_id uuid not null,
  redacted_facts jsonb not null check (
    jsonb_typeof(redacted_facts) = 'object' and octet_length(redacted_facts::text) <= 64000
  ),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  redaction_version integer not null check (redaction_version > 0),
  created_at timestamptz not null default now(),
  primary key (evidence_id, workspace_id),
  foreign key (evidence_id, workspace_id)
    references public.action_evidence(id, workspace_id) on delete cascade
);
create function app_private.validate_action_evidence_payload()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if not exists (
    select 1 from public.action_evidence e
    where e.id = new.evidence_id and e.workspace_id = new.workspace_id
      and e.evidence_hash = new.payload_hash
  ) then
    raise exception 'private evidence payload hash mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function app_private.validate_action_evidence_payload()
from public, anon, authenticated;
create trigger action_evidence_payloads_validate
before insert on app_private.action_evidence_payloads
for each row execute function app_private.validate_action_evidence_payload();
create trigger action_evidence_payloads_append_only
before update or delete on app_private.action_evidence_payloads
for each row execute function app_private.reject_append_only_change();

create table public.reconciliation_cases (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid not null,
  action_request_id uuid not null,
  unknown_result_id uuid not null unique,
  method text not null check (method in ('provider_lookup','postcondition_read','owner_confirmation')),
  status text not null default 'pending' check (
    status in ('pending','running','reconciled_succeeded','reconciled_failed','inconclusive','manual_required')
  ),
  attempt integer not null default 0 check (attempt >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz not null default now(),
  last_error_code text check (last_error_code is null or char_length(last_error_code) <= 128),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (run_id, workspace_id)
    references public.agent_runs(id, workspace_id) on delete restrict,
  foreign key (action_request_id, run_id, workspace_id)
    references public.action_requests(id, run_id, workspace_id) on delete restrict,
  foreign key (unknown_result_id, run_id, workspace_id)
    references public.tool_results(id, run_id, workspace_id) on delete restrict,
  check (attempt <= max_attempts)
);
create function app_private.validate_reconciliation_case()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if not exists (
    select 1 from public.tool_results r
    where r.id = new.unknown_result_id
      and r.workspace_id = new.workspace_id
      and r.run_id = new.run_id
      and r.action_request_id = new.action_request_id
      and r.certainty = 'unknown'
  ) then
    raise exception 'reconciliation case must reference the matching unknown result'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function app_private.validate_reconciliation_case()
from public, anon, authenticated;
create trigger reconciliation_cases_validate_unknown
before insert on public.reconciliation_cases
for each row execute function app_private.validate_reconciliation_case();
create function app_private.protect_reconciliation_case()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('app_private.execution_history_purge_workspace', true)
        = old.workspace_id::text then return old; end if;
    raise exception 'reconciliation cases are durable execution history' using errcode = '55000';
  end if;
  if new.workspace_id is distinct from old.workspace_id
     or new.run_id is distinct from old.run_id
     or new.action_request_id is distinct from old.action_request_id
     or new.unknown_result_id is distinct from old.unknown_result_id
     or new.method is distinct from old.method
     or new.max_attempts is distinct from old.max_attempts
     or new.created_at is distinct from old.created_at then
    raise exception 'reconciliation identity is immutable' using errcode = '55000';
  end if;
  if old.status in ('reconciled_succeeded','reconciled_failed','manual_required') then
    raise exception 'terminal reconciliation case is immutable' using errcode = '55000';
  end if;
  if not (
    (old.status in ('pending','inconclusive') and new.status = 'running'
      and new.attempt = old.attempt + 1)
    or (old.status = 'running' and new.status = 'running'
      and new.attempt = old.attempt + 1 and not exists (
        select 1 from app_private.reconciliation_claims l
        where l.case_id = old.id and l.workspace_id = old.workspace_id
          and l.lease_expires_at > now()
      ))
    or (old.status = 'running'
      and new.status in ('inconclusive','manual_required','reconciled_succeeded','reconciled_failed')
      and new.attempt = old.attempt)
  ) then
    raise exception 'invalid reconciliation transition' using errcode = '55000';
  end if;
  return new;
end;
$$;
revoke all on function app_private.protect_reconciliation_case()
from public, anon, authenticated;
create trigger reconciliation_cases_protect
before update or delete on public.reconciliation_cases
for each row execute function app_private.protect_reconciliation_case();
create index reconciliation_cases_due_idx
on public.reconciliation_cases (next_attempt_at)
where status in ('pending','running','inconclusive');
create trigger reconciliation_cases_updated before update on public.reconciliation_cases
for each row execute function app_private.set_updated_at();

create table app_private.reconciliation_claims (
  case_id uuid not null,
  workspace_id uuid not null,
  lease_epoch integer not null check (lease_epoch > 0),
  claim_token_hash text not null check (claim_token_hash ~ '^[0-9a-f]{64}$'),
  lease_expires_at timestamptz not null,
  primary key (case_id, workspace_id),
  foreign key (case_id, workspace_id)
    references public.reconciliation_cases(id, workspace_id) on delete cascade
);

alter table public.authority_grants enable row level security;
alter table public.authority_usages enable row level security;
alter table public.action_evidence enable row level security;
alter table public.reconciliation_cases enable row level security;

revoke all on public.authority_grants, public.authority_usages,
  public.action_evidence, public.reconciliation_cases from public, anon, authenticated;
grant select on public.authority_grants, public.authority_usages,
  public.action_evidence, public.reconciliation_cases to authenticated;
revoke all on app_private.action_evidence_payloads,
  app_private.reconciliation_claims from public, anon, authenticated, service_role;

create policy authority_grants_select_owner on public.authority_grants
for select to authenticated using (exists (
  select 1 from public.workspaces w where w.id = workspace_id and w.owner_user_id = (select auth.uid())
));
create policy authority_usages_select_owner on public.authority_usages
for select to authenticated using (exists (
  select 1 from public.workspaces w where w.id = workspace_id and w.owner_user_id = (select auth.uid())
));
create policy action_evidence_select_owner on public.action_evidence
for select to authenticated using (exists (
  select 1 from public.workspaces w where w.id = workspace_id and w.owner_user_id = (select auth.uid())
));
create policy reconciliation_cases_select_owner on public.reconciliation_cases
for select to authenticated using (exists (
  select 1 from public.workspaces w where w.id = workspace_id and w.owner_user_id = (select auth.uid())
));

comment on table public.authority_grants is
  'Owner-visible, versioned semantic authority. Writes are server-mediated; financial and security grants are disabled in Phase 3.';
comment on table public.action_evidence is
  'Append-only bounded evidence metadata. Redacted structured facts remain in app_private.';

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
  delete from app_private.reconciliation_claims where workspace_id = target_workspace_id;
  delete from app_private.action_evidence_payloads where workspace_id = target_workspace_id;
  delete from public.reconciliation_cases where workspace_id = target_workspace_id;
  delete from public.action_evidence where workspace_id = target_workspace_id;
  delete from public.authority_usages where workspace_id = target_workspace_id;
  delete from public.artifacts where workspace_id = target_workspace_id;
  delete from public.browser_executions where workspace_id = target_workspace_id;
  delete from public.site_support where workspace_id = target_workspace_id;
  delete from public.run_events where workspace_id = target_workspace_id;
  delete from public.audit_events where workspace_id = target_workspace_id;
  delete from public.tool_results where workspace_id = target_workspace_id and reconciles_result_id is not null;
  delete from public.tool_results where workspace_id = target_workspace_id;
  delete from public.action_requests where workspace_id = target_workspace_id;
  delete from public.authority_grants where workspace_id = target_workspace_id;
  delete from public.workspaces where id = target_workspace_id;
end;
$$;
