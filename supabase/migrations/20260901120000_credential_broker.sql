-- Phase 4: owner-held website credential vault and model-blind injection metadata.

create function app_private.valid_credential_origins(origins text[])
returns boolean language sql immutable strict set search_path = '' as $$
  select cardinality(origins) between 1 and 20
    and coalesce(bool_and(
      origin ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$'
      and char_length(origin) <= 500
    ), false)
  from unnest(origins) as origin
$$;
revoke all on function app_private.valid_credential_origins(text[])
from public, anon, authenticated;

create table public.credential_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null check (kind = 'website_password'),
  label text not null check (char_length(label) between 1 and 200),
  username_hint text check (username_hint is null or char_length(username_hint) <= 200),
  allowed_origins text[] not null check (app_private.valid_credential_origins(allowed_origins)),
  status text not null default 'needs_verification' check (
    status in ('active','needs_verification','revoked','deletion_pending','deleted')
  ),
  record_version integer not null default 1 check (record_version > 0),
  configuration_version text not null check (configuration_version ~ '^[0-9a-f]{64}$'),
  encryption_key_version integer not null check (encryption_key_version > 0),
  last_verified_at timestamptz,
  rotation_due_at timestamptz,
  revoked_at timestamptz,
  deletion_requested_at timestamptz,
  deletion_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  unique (id, workspace_id, configuration_version),
  check ((status in ('revoked','deletion_pending','deleted')) = (revoked_at is not null)),
  check ((status in ('deletion_pending','deleted')) = (deletion_requested_at is not null)),
  check ((status = 'deleted') = (deletion_verified_at is not null)),
  check (deletion_verified_at is null or deletion_verified_at >= deletion_requested_at)
);
create trigger credential_items_updated before update on public.credential_items
for each row execute function app_private.set_updated_at();
create function app_private.protect_credential_item()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('app_private.execution_history_purge_workspace', true)
        = old.workspace_id::text then return old; end if;
    raise exception 'credential metadata is durable security history' using errcode = '55000';
  end if;
  if new.workspace_id is distinct from old.workspace_id
     or new.kind is distinct from old.kind
     or new.created_at is distinct from old.created_at then
    raise exception 'credential identity is immutable' using errcode = '55000';
  end if;
  if (old.status = 'revoked' and new.status not in ('revoked','deletion_pending'))
     or (old.status = 'deletion_pending' and new.status not in ('deletion_pending','deleted'))
     or (old.status = 'deleted' and new.status <> 'deleted') then
    raise exception 'credential revocation is irreversible' using errcode = '55000';
  end if;
  if new.status is distinct from old.status and not (
    (old.status = 'needs_verification' and new.status in ('active','revoked'))
    or (old.status = 'active' and new.status in ('needs_verification','revoked'))
    or (old.status = 'revoked' and new.status = 'deletion_pending')
    or (old.status = 'deletion_pending' and new.status = 'deleted')
  ) then
    raise exception 'invalid credential lifecycle transition' using errcode = '55000';
  end if;
  if (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at)
     or (old.deletion_requested_at is not null and new.deletion_requested_at is distinct from old.deletion_requested_at)
     or (old.deletion_verified_at is not null and new.deletion_verified_at is distinct from old.deletion_verified_at) then
    raise exception 'credential lifecycle timestamps are immutable' using errcode = '55000';
  end if;
  if old.status in ('revoked','deletion_pending','deleted') and (
    new.label is distinct from old.label
    or new.allowed_origins is distinct from old.allowed_origins
    or new.record_version is distinct from old.record_version
    or new.configuration_version is distinct from old.configuration_version
    or new.encryption_key_version is distinct from old.encryption_key_version
    or new.last_verified_at is distinct from old.last_verified_at
    or new.rotation_due_at is distinct from old.rotation_due_at
    or (new.username_hint is distinct from old.username_hint and new.username_hint is not null)
  ) then
    raise exception 'revoked credential history is immutable' using errcode = '55000';
  end if;
  if new.status = 'deleted' and old.status <> 'deleted' and exists (
    select 1 from app_private.credential_secrets s
    where s.credential_item_id = old.id and s.workspace_id = old.workspace_id
  ) then
    raise exception 'credential ciphertext deletion is unverified' using errcode = '55000';
  end if;
  if (new.allowed_origins is distinct from old.allowed_origins
      or new.configuration_version is distinct from old.configuration_version)
     is distinct from (new.record_version = old.record_version + 1) then
    raise exception 'credential configuration and record version must advance together' using errcode = '55000';
  end if;
  return new;
end;
$$;
revoke all on function app_private.protect_credential_item()
from public, anon, authenticated;
create trigger credential_items_protect before update or delete on public.credential_items
for each row execute function app_private.protect_credential_item();

create table app_private.credential_item_versions (
  credential_item_id uuid not null,
  workspace_id uuid not null,
  configuration_version text not null check (configuration_version ~ '^[0-9a-f]{64}$'),
  record_version integer not null check (record_version > 0),
  allowed_origins text[] not null check (app_private.valid_credential_origins(allowed_origins)),
  created_at timestamptz not null default now(),
  primary key (credential_item_id, workspace_id, configuration_version),
  unique (credential_item_id, workspace_id, record_version),
  foreign key (credential_item_id, workspace_id)
    references public.credential_items(id, workspace_id) on delete cascade
);
create function app_private.protect_credential_item_version()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'DELETE' and
     current_setting('app_private.execution_history_purge_workspace', true)
       = old.workspace_id::text then return old; end if;
  raise exception 'credential configuration history is append-only' using errcode = '55000';
end;
$$;
revoke all on function app_private.protect_credential_item_version()
from public, anon, authenticated;
create trigger credential_item_versions_append_only before update or delete
on app_private.credential_item_versions for each row
execute function app_private.protect_credential_item_version();

create table app_private.credential_secrets (
  credential_item_id uuid not null,
  workspace_id uuid not null,
  record_version integer not null check (record_version > 0),
  envelope jsonb not null check (
    jsonb_typeof(envelope) = 'object' and octet_length(envelope::text) <= 120000
    and envelope ?& array[
      'version','keyVersion','wrappedKeyNonce','wrappedKeyTag',
      'wrappedKeyCiphertext','payloadNonce','payloadTag','payloadCiphertext'
    ]
    and (envelope->>'version')::integer = 1
    and (envelope->>'keyVersion')::integer > 0
    and envelope->>'wrappedKeyNonce' ~ '^[A-Za-z0-9_-]{16,64}$'
    and envelope->>'wrappedKeyTag' ~ '^[A-Za-z0-9_-]{16,64}$'
    and envelope->>'wrappedKeyCiphertext' ~ '^[A-Za-z0-9_-]{32,128}$'
    and envelope->>'payloadNonce' ~ '^[A-Za-z0-9_-]{16,64}$'
    and envelope->>'payloadTag' ~ '^[A-Za-z0-9_-]{16,64}$'
    and envelope->>'payloadCiphertext' ~ '^[A-Za-z0-9_-]+$'
    and char_length(envelope->>'payloadCiphertext') <= 100000
  ),
  created_at timestamptz not null default now(),
  reencrypted_at timestamptz,
  primary key (credential_item_id, workspace_id),
  foreign key (credential_item_id, workspace_id)
    references public.credential_items(id, workspace_id) on delete cascade,
  foreign key (credential_item_id, workspace_id, record_version)
    references app_private.credential_item_versions(
      credential_item_id, workspace_id, record_version
    ) on delete restrict
);
create function app_private.validate_credential_secret()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.credential_item_id is distinct from old.credential_item_id
       or new.workspace_id is distinct from old.workspace_id
       or new.created_at is distinct from old.created_at then
      raise exception 'credential secret identity is immutable' using errcode = '55000';
    end if;
    if (new.envelope->>'payloadNonce' is distinct from old.envelope->>'payloadNonce'
        or new.envelope->>'payloadTag' is distinct from old.envelope->>'payloadTag'
        or new.envelope->>'payloadCiphertext' is distinct from old.envelope->>'payloadCiphertext')
       is distinct from (new.record_version = old.record_version + 1) then
      raise exception 'credential payload and record version must advance together' using errcode = '55000';
    end if;
  end if;
  if not exists (
    select 1 from public.credential_items i
    where i.id = new.credential_item_id and i.workspace_id = new.workspace_id
      and i.record_version = new.record_version
      and i.encryption_key_version = (new.envelope->>'keyVersion')::integer
      and i.status in ('active','needs_verification')
  ) then
    raise exception 'credential envelope does not match active metadata' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function app_private.validate_credential_secret()
from public, anon, authenticated;
create trigger credential_secrets_validate before insert or update
on app_private.credential_secrets for each row
execute function app_private.validate_credential_secret();

create unique index browser_control_sessions_id_workspace_idx
on app_private.browser_control_sessions(id, workspace_id);

create table public.credential_access_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  credential_item_id uuid not null,
  executor text not null check (executor in ('owner','worker','system')),
  exact_origin text check (
    exact_origin is null or
    (exact_origin ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$' and char_length(exact_origin) <= 500)
  ),
  browser_profile_id uuid,
  browser_execution_id uuid,
  browser_control_session_id uuid,
  run_id uuid,
  action_request_id uuid,
  reason_code text not null check (char_length(reason_code) between 1 and 128),
  result text not null check (result in (
    'requested','injected','denied','failed','unknown','revealed','exported','rotated','revoked','deleted'
  )),
  detail jsonb not null default '{}'::jsonb check (
    jsonb_typeof(detail) = 'object' and octet_length(detail::text) <= 4000
  ),
  occurred_at timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (credential_item_id, workspace_id)
    references public.credential_items(id, workspace_id) on delete restrict,
  foreign key (run_id, workspace_id)
    references public.agent_runs(id, workspace_id) on delete restrict,
  foreign key (action_request_id, workspace_id)
    references public.action_requests(id, workspace_id) on delete restrict
);
create function app_private.validate_credential_access_event()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.browser_profile_id is not null and not exists (
    select 1 from public.browser_profiles p
    where p.id = new.browser_profile_id and p.workspace_id = new.workspace_id
  ) then raise exception 'credential access profile lineage mismatch' using errcode = '23514'; end if;
  if new.browser_execution_id is not null and
     (new.browser_profile_id is null or new.run_id is null) then
    raise exception 'credential access execution requires profile and run anchors' using errcode = '23514';
  end if;
  if new.browser_execution_id is not null and not exists (
    select 1 from public.browser_executions e
    where e.id = new.browser_execution_id and e.workspace_id = new.workspace_id
      and e.profile_id = new.browser_profile_id and e.run_id = new.run_id
  ) then raise exception 'credential access execution lineage mismatch' using errcode = '23514'; end if;
  if new.browser_control_session_id is not null and new.browser_profile_id is null then
    raise exception 'credential access control session requires a profile anchor' using errcode = '23514';
  end if;
  if new.browser_control_session_id is not null and not exists (
    select 1 from app_private.browser_control_sessions c
    where c.id = new.browser_control_session_id and c.workspace_id = new.workspace_id
      and c.profile_id = new.browser_profile_id
  ) then raise exception 'credential access control-session lineage mismatch' using errcode = '23514'; end if;
  if new.action_request_id is not null and new.run_id is null then
    raise exception 'credential access action requires a run anchor' using errcode = '23514';
  end if;
  if new.action_request_id is not null and not exists (
    select 1 from public.action_requests a
    where a.id = new.action_request_id and a.workspace_id = new.workspace_id
      and a.run_id = new.run_id
  ) then raise exception 'credential access action lineage mismatch' using errcode = '23514'; end if;
  return new;
end;
$$;
revoke all on function app_private.validate_credential_access_event()
from public, anon, authenticated;
create trigger credential_access_events_validate before insert
on public.credential_access_events for each row
execute function app_private.validate_credential_access_event();
create trigger credential_access_events_append_only
before update or delete on public.credential_access_events
for each row execute function app_private.reject_append_only_change();

create table public.credential_profile_bindings (
  credential_item_id uuid not null,
  workspace_id uuid not null,
  browser_profile_id uuid not null,
  credential_configuration_version text not null check (
    credential_configuration_version ~ '^[0-9a-f]{64}$'
  ),
  status text not null default 'active' check (status in ('active','invalidated')),
  bound_at timestamptz not null default now(),
  invalidated_at timestamptz,
  primary key (credential_item_id, browser_profile_id),
  foreign key (credential_item_id, workspace_id)
    references public.credential_items(id, workspace_id) on delete restrict,
  foreign key (browser_profile_id, workspace_id)
    references public.browser_profiles(id, workspace_id) on delete cascade,
  foreign key (credential_item_id, workspace_id, credential_configuration_version)
    references app_private.credential_item_versions(
      credential_item_id, workspace_id, configuration_version
    ) on delete restrict,
  check ((status = 'invalidated') = (invalidated_at is not null))
);
create function app_private.protect_credential_profile_binding()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (
    new.credential_item_id is distinct from old.credential_item_id
    or new.workspace_id is distinct from old.workspace_id
    or new.browser_profile_id is distinct from old.browser_profile_id
    or new.bound_at is distinct from old.bound_at and new.status <> 'active'
  ) then
    raise exception 'credential profile binding identity is immutable' using errcode = '55000';
  end if;
  -- Leave cross-workspace identity failures to the composite foreign key so
  -- callers receive the standard referential-integrity error.
  if not exists (
    select 1 from public.credential_items i
    where i.id = new.credential_item_id and i.workspace_id = new.workspace_id
  ) then
    return new;
  end if;
  if new.status = 'active' and not exists (
    select 1 from public.credential_items i
    where i.id = new.credential_item_id and i.workspace_id = new.workspace_id
      and i.configuration_version = new.credential_configuration_version
      and i.status in ('active','needs_verification')
  ) then
    raise exception 'active credential binding does not match current credential metadata' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and old.status = 'invalidated' and new.status = 'active'
     and new.credential_configuration_version = old.credential_configuration_version then
    raise exception 'an invalidated credential binding cannot be reactivated for the same configuration' using errcode = '55000';
  end if;
  return new;
end;
$$;
revoke all on function app_private.protect_credential_profile_binding()
from public, anon, authenticated;
create trigger credential_profile_bindings_protect before insert or update
on public.credential_profile_bindings for each row
execute function app_private.protect_credential_profile_binding();

create table app_private.credential_injection_leases (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  credential_item_id uuid not null,
  credential_configuration_version text not null check (
    credential_configuration_version ~ '^[0-9a-f]{64}$'
  ),
  browser_profile_id uuid not null,
  browser_profile_configuration_version bigint not null check (
    browser_profile_configuration_version > 0
  ),
  control_session_id uuid not null,
  exact_origin text not null check (
    exact_origin ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$' and char_length(exact_origin) <= 500
  ),
  field_binding_hash text not null check (field_binding_hash ~ '^[0-9a-f]{64}$'),
  claim_token_hash text not null check (claim_token_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'prepared' check (
    status in ('prepared','invocation_started','injected','failed','unknown','expired')
  ),
  expires_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (credential_item_id, control_session_id),
  foreign key (credential_item_id, workspace_id)
    references public.credential_items(id, workspace_id) on delete restrict,
  foreign key (browser_profile_id, workspace_id)
    references public.browser_profiles(id, workspace_id) on delete cascade,
  foreign key (credential_item_id, workspace_id, credential_configuration_version)
    references app_private.credential_item_versions(
      credential_item_id, workspace_id, configuration_version
    ) on delete restrict,
  foreign key (control_session_id, workspace_id)
    references app_private.browser_control_sessions(id, workspace_id) on delete cascade,
  check ((status in ('injected','failed','unknown','expired')) = (completed_at is not null))
);
create function app_private.validate_credential_injection_lease()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if not exists (
    select 1 from public.credential_items i
    join public.browser_profiles p on p.id = new.browser_profile_id
      and p.workspace_id = new.workspace_id
    join app_private.browser_control_sessions c on c.id = new.control_session_id
      and c.workspace_id = new.workspace_id and c.profile_id = p.id
    where i.id = new.credential_item_id and i.workspace_id = new.workspace_id
      and i.configuration_version = new.credential_configuration_version
      and new.exact_origin = any(i.allowed_origins)
      and i.status in ('active','needs_verification')
      and p.configuration_version = new.browser_profile_configuration_version
      and p.status in ('needs_login','needs_reauth') and c.status = 'active'
  ) then
    raise exception 'credential injection lease does not match current authority' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function app_private.validate_credential_injection_lease()
from public, anon, authenticated;
create trigger credential_injection_leases_validate before insert
on app_private.credential_injection_leases for each row
execute function app_private.validate_credential_injection_lease();
create function app_private.protect_credential_injection_lease()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id
     or new.credential_item_id is distinct from old.credential_item_id
     or new.credential_configuration_version is distinct from old.credential_configuration_version
     or new.browser_profile_id is distinct from old.browser_profile_id
     or new.browser_profile_configuration_version is distinct from old.browser_profile_configuration_version
     or new.control_session_id is distinct from old.control_session_id
     or new.exact_origin is distinct from old.exact_origin
     or new.field_binding_hash is distinct from old.field_binding_hash
     or new.claim_token_hash is distinct from old.claim_token_hash
     or new.expires_at is distinct from old.expires_at
     or new.created_at is distinct from old.created_at then
    raise exception 'credential injection lease identity is immutable' using errcode = '55000';
  end if;
  if not (
    (old.status = 'prepared' and new.status in ('invocation_started','expired'))
    or (old.status = 'invocation_started' and new.status in ('injected','failed','unknown'))
  ) then
    raise exception 'invalid credential injection lease transition' using errcode = '55000';
  end if;
  return new;
end;
$$;
revoke all on function app_private.protect_credential_injection_lease()
from public, anon, authenticated;
create trigger credential_injection_leases_protect before update
on app_private.credential_injection_leases for each row
execute function app_private.protect_credential_injection_lease();
create unique index credential_injection_one_active_session_idx
on app_private.credential_injection_leases(control_session_id)
where status in ('prepared','invocation_started');

create index credential_items_workspace_status_idx
on public.credential_items(workspace_id, status, label);
create index credential_access_events_item_time_idx
on public.credential_access_events(credential_item_id, occurred_at desc);
create index credential_profile_bindings_profile_idx
on public.credential_profile_bindings(browser_profile_id, status);
create index credential_injection_expiry_idx
on app_private.credential_injection_leases(expires_at)
where status in ('prepared','invocation_started');

alter table public.credential_items enable row level security;
alter table public.credential_access_events enable row level security;
alter table public.credential_profile_bindings enable row level security;
revoke all on public.credential_items, public.credential_access_events,
  public.credential_profile_bindings from public, anon, authenticated;
grant select on public.credential_items, public.credential_access_events,
  public.credential_profile_bindings to authenticated;
revoke all on app_private.credential_secrets, app_private.credential_item_versions,
  app_private.credential_injection_leases from public, anon, authenticated, service_role;

create policy credential_items_select_owner on public.credential_items
for select to authenticated using (exists (
  select 1 from public.workspaces w
  where w.id = workspace_id and w.owner_user_id = (select auth.uid())
));
create policy credential_access_events_select_owner on public.credential_access_events
for select to authenticated using (exists (
  select 1 from public.workspaces w
  where w.id = workspace_id and w.owner_user_id = (select auth.uid())
));
create policy credential_profile_bindings_select_owner on public.credential_profile_bindings
for select to authenticated using (exists (
  select 1 from public.workspaces w
  where w.id = workspace_id and w.owner_user_id = (select auth.uid())
));

comment on table app_private.credential_secrets is
  'Envelope-encrypted website credentials. No Data API role has privileges.';
comment on table public.credential_access_events is
  'Append-only metadata-only credential access audit; secrets and DOM content are forbidden.';

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
  if exists (select 1 from public.credential_items
    where workspace_id = target_workspace_id and status <> 'deleted') then
    raise exception 'credential ciphertext must be deleted before workspace purge'
      using errcode = '55000';
  end if;
  if exists (select 1 from app_private.credential_secrets
    where workspace_id = target_workspace_id) then
    raise exception 'credential ciphertext deletion must be verified before workspace purge'
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
  if exists (select 1 from app_private.artifact_locations
    where workspace_id = target_workspace_id) then
    raise exception 'artifact byte locations must be removed before workspace purge'
      using errcode = '55000';
  end if;
  perform set_config('app_private.execution_history_purge_workspace', target_workspace_id::text, true);
  delete from app_private.credential_injection_leases where workspace_id = target_workspace_id;
  delete from app_private.credential_secrets where workspace_id = target_workspace_id;
  delete from public.credential_profile_bindings where workspace_id = target_workspace_id;
  delete from public.credential_access_events where workspace_id = target_workspace_id;
  delete from public.credential_items where workspace_id = target_workspace_id;
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
