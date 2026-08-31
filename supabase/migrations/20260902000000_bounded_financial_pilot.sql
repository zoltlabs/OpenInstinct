-- Phase 5: bounded, owner-approved sandbox financial pilot.

create table public.financial_settings (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  enabled boolean not null default false,
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  per_transaction_limit bigint not null default 0 check (per_transaction_limit >= 0),
  daily_limit bigint not null default 0 check (daily_limit >= 0),
  monthly_limit bigint not null default 0 check (monthly_limit >= 0),
  configuration_version text not null check (configuration_version ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null default now(),
  check (per_transaction_limit <= daily_limit and daily_limit <= monthly_limit)
);
create trigger financial_settings_updated before update on public.financial_settings
for each row execute function app_private.set_updated_at();

create function app_private.version_financial_settings()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.configuration_version := encode(extensions.digest(
    jsonb_build_object(
      'enabled', new.enabled,
      'currency', new.currency,
      'perTransactionLimit', new.per_transaction_limit::text,
      'dailyLimit', new.daily_limit::text,
      'monthlyLimit', new.monthly_limit::text
    )::text, 'sha256'), 'hex');
  return new;
end;
$$;
revoke all on function app_private.version_financial_settings() from public, anon, authenticated;
create trigger financial_settings_version before insert or update on public.financial_settings
for each row execute function app_private.version_financial_settings();

create table public.financial_merchants (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null default 'openinstinct_sandbox'
    check (provider = 'openinstinct_sandbox'),
  merchant_key text not null check (merchant_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  display_name text not null check (char_length(display_name) between 1 and 200),
  exact_origin text not null check (exact_origin ~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?$'),
  enabled boolean not null default false,
  per_transaction_limit bigint not null default 0 check (per_transaction_limit >= 0),
  configuration_version text not null check (configuration_version ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, merchant_key),
  unique (id, workspace_id)
);
create trigger financial_merchants_updated before update on public.financial_merchants
for each row execute function app_private.set_updated_at();

create function app_private.protect_and_version_financial_merchant()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (
    new.id is distinct from old.id or
    new.workspace_id is distinct from old.workspace_id or
    new.provider is distinct from old.provider or
    new.merchant_key is distinct from old.merchant_key or
    new.display_name is distinct from old.display_name or
    new.exact_origin is distinct from old.exact_origin or
    new.created_at is distinct from old.created_at
  ) then
    raise exception 'financial merchant identity is immutable' using errcode = '55000';
  end if;
  new.configuration_version := encode(extensions.digest(
    jsonb_build_object(
      'provider', new.provider,
      'merchantKey', new.merchant_key,
      'exactOrigin', new.exact_origin,
      'enabled', new.enabled,
      'perTransactionLimit', new.per_transaction_limit::text
    )::text, 'sha256'), 'hex');
  return new;
end;
$$;
revoke all on function app_private.protect_and_version_financial_merchant() from public, anon, authenticated;
create trigger financial_merchants_protect_and_version
before insert or update on public.financial_merchants
for each row execute function app_private.protect_and_version_financial_merchant();

create table public.payment_aliases (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null default 'openinstinct_sandbox'
    check (provider = 'openinstinct_sandbox'),
  label text not null check (char_length(label) between 1 and 120),
  last_four text check (last_four is null or last_four ~ '^[0-9]{4}$'),
  status text not null default 'disabled' check (status in ('active','disabled','revoked')),
  configuration_version text not null check (configuration_version ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id)
);
create trigger payment_aliases_updated before update on public.payment_aliases
for each row execute function app_private.set_updated_at();

create function app_private.protect_and_version_payment_alias()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (
    new.id is distinct from old.id or
    new.workspace_id is distinct from old.workspace_id or
    new.provider is distinct from old.provider or
    new.created_at is distinct from old.created_at
  ) then
    raise exception 'payment alias identity is immutable' using errcode = '55000';
  end if;
  if tg_op = 'UPDATE' and old.status = 'revoked' and new.status <> 'revoked' then
    raise exception 'payment alias revocation is irreversible' using errcode = '55000';
  end if;
  new.configuration_version := encode(extensions.digest(
    jsonb_build_object(
      'provider', new.provider,
      'label', new.label,
      'lastFour', new.last_four,
      'status', new.status
    )::text, 'sha256'), 'hex');
  return new;
end;
$$;
revoke all on function app_private.protect_and_version_payment_alias() from public, anon, authenticated;
create trigger payment_aliases_protect_and_version
before insert or update on public.payment_aliases
for each row execute function app_private.protect_and_version_payment_alias();

create table app_private.payment_alias_handles (
  payment_alias_id uuid primary key,
  workspace_id uuid not null,
  opaque_handle text not null check (char_length(opaque_handle) between 1 and 1000),
  created_at timestamptz not null default now(),
  foreign key (payment_alias_id, workspace_id)
    references public.payment_aliases(id, workspace_id) on delete cascade
);
revoke all on app_private.payment_alias_handles from public, anon, authenticated, service_role;

create function app_private.require_payment_alias_handle()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'active' and not exists (
    select 1 from app_private.payment_alias_handles h
    where h.payment_alias_id = new.id and h.workspace_id = new.workspace_id
  ) then
    raise exception 'active payment alias requires a private provider handle' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function app_private.require_payment_alias_handle() from public, anon, authenticated;
create constraint trigger payment_aliases_require_handle
after insert or update of status on public.payment_aliases
for each row execute function app_private.require_payment_alias_handle();

create function app_private.protect_payment_alias_handle()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'DELETE' and
     current_setting('app_private.execution_history_purge_workspace', true) = old.workspace_id::text then
    return old;
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'payment alias handles are immutable' using errcode = '55000';
  end if;
  if exists (
    select 1 from public.payment_aliases a
    where a.id = old.payment_alias_id and a.workspace_id = old.workspace_id
      and a.status = 'active'
  ) then
    raise exception 'active payment alias handle cannot be removed' using errcode = '55000';
  end if;
  return old;
end;
$$;
revoke all on function app_private.protect_payment_alias_handle() from public, anon, authenticated, service_role;
create trigger payment_alias_handles_protect
before update or delete on app_private.payment_alias_handles
for each row execute function app_private.protect_payment_alias_handle();

create table app_private.financial_preflights (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  action_request_id uuid,
  provider text not null check (provider = 'openinstinct_sandbox'),
  merchant_id uuid not null,
  merchant_key text not null,
  item_id text not null check (char_length(item_id) between 1 and 256),
  item_description text not null check (char_length(item_description) between 1 and 256),
  quantity integer not null check (quantity between 1 and 100),
  unit_minor_units bigint not null check (unit_minor_units >= 0),
  total_minor_units bigint not null check (total_minor_units >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  recurring_terms jsonb,
  payment_alias_id uuid not null,
  merchant_configuration_version text not null check (merchant_configuration_version ~ '^[0-9a-f]{64}$'),
  payment_alias_configuration_version text not null check (payment_alias_configuration_version ~ '^[0-9a-f]{64}$'),
  settings_configuration_version text not null check (settings_configuration_version ~ '^[0-9a-f]{64}$'),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  preflight_hash text not null check (preflight_hash ~ '^[0-9a-f]{64}$'),
  quote_expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (action_request_id),
  unique (id, workspace_id),
  foreign key (action_request_id, workspace_id)
    references public.action_requests(id, workspace_id) on delete restrict,
  foreign key (merchant_id, workspace_id)
    references public.financial_merchants(id, workspace_id) on delete restrict,
  foreign key (payment_alias_id, workspace_id)
    references public.payment_aliases(id, workspace_id) on delete restrict,
  check (total_minor_units = unit_minor_units * quantity),
  check (recurring_terms is null or (jsonb_typeof(recurring_terms) = 'object' and octet_length(recurring_terms::text) <= 2000)),
  check ((consumed_at is null) or (action_request_id is not null))
);
revoke all on app_private.financial_preflights from public, anon, authenticated, service_role;

create function app_private.protect_financial_preflight()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('app_private.execution_history_purge_workspace', true) = old.workspace_id::text then return old; end if;
    raise exception 'financial preflights are durable approval evidence' using errcode = '55000';
  end if;
  if (to_jsonb(new) - array['action_request_id','consumed_at']) is distinct from
     (to_jsonb(old) - array['action_request_id','consumed_at']) or
     (old.action_request_id is not null and new.action_request_id is distinct from old.action_request_id) or
     (old.consumed_at is not null and new.consumed_at is distinct from old.consumed_at) or
     (new.action_request_id is null and new.consumed_at is not null) then
    raise exception 'financial preflight snapshot is immutable' using errcode = '55000';
  end if;
  return new;
end;
$$;
revoke all on function app_private.protect_financial_preflight() from public, anon, authenticated;
create trigger financial_preflights_protect before update or delete on app_private.financial_preflights
for each row execute function app_private.protect_financial_preflight();

create table public.financial_transactions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  action_request_id uuid not null,
  preflight_id uuid,
  merchant_id uuid not null,
  payment_alias_id uuid not null,
  kind text not null default 'purchase' check (kind in ('purchase','refund','cancellation')),
  parent_transaction_id uuid,
  amount_minor_units bigint not null check (amount_minor_units >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  recurring_terms jsonb,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 256),
  status text not null check (status in ('committed','refunded','cancelled','unknown','failed')),
  provider_transaction_id text,
  committed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (action_request_id),
  unique (parent_transaction_id, kind),
  unique (workspace_id, idempotency_key),
  unique (id, workspace_id),
  foreign key (action_request_id, workspace_id)
    references public.action_requests(id, workspace_id) on delete restrict,
  foreign key (preflight_id, workspace_id)
    references app_private.financial_preflights(id, workspace_id) on delete restrict,
  foreign key (merchant_id, workspace_id)
    references public.financial_merchants(id, workspace_id) on delete restrict,
  foreign key (payment_alias_id, workspace_id)
    references public.payment_aliases(id, workspace_id) on delete restrict,
  foreign key (parent_transaction_id, workspace_id)
    references public.financial_transactions(id, workspace_id) on delete restrict,
  check ((kind = 'purchase' and parent_transaction_id is null) or
         (kind in ('refund','cancellation') and parent_transaction_id is not null)),
  check ((kind = 'purchase') = (preflight_id is not null)),
  check ((status in ('committed','refunded','cancelled')) = (committed_at is not null)),
  check (recurring_terms is null or (jsonb_typeof(recurring_terms) = 'object' and octet_length(recurring_terms::text) <= 2000))
);
create unique index financial_transactions_purchase_preflight_idx
on public.financial_transactions (preflight_id) where kind = 'purchase';
create index financial_transactions_spend_idx
on public.financial_transactions (workspace_id, committed_at desc)
where status in ('committed','unknown');

create table public.spend_ledger (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  transaction_id uuid not null,
  entry_type text not null check (entry_type in ('debit','credit')),
  amount_minor_units bigint not null check (amount_minor_units >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (transaction_id, entry_type),
  foreign key (transaction_id, workspace_id)
    references public.financial_transactions(id, workspace_id) on delete restrict
);
create trigger spend_ledger_append_only before update or delete on public.spend_ledger
for each row execute function app_private.reject_append_only_change();

create table public.financial_receipts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  transaction_id uuid not null,
  receipt_number text not null check (char_length(receipt_number) between 1 and 256),
  safe_summary jsonb not null check (jsonb_typeof(safe_summary) = 'object' and octet_length(safe_summary::text) <= 8000),
  evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (transaction_id),
  unique (workspace_id, receipt_number),
  foreign key (transaction_id, workspace_id)
    references public.financial_transactions(id, workspace_id) on delete restrict
);
create trigger financial_receipts_append_only before update or delete on public.financial_receipts
for each row execute function app_private.reject_append_only_change();

create table public.financial_reconciliation_reads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  transaction_id uuid not null,
  action_request_id uuid not null,
  observed_status text not null check (observed_status in ('committed','refunded','cancelled','unknown','failed')),
  observed_hash text not null check (observed_hash ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz not null default now(),
  foreign key (transaction_id, workspace_id)
    references public.financial_transactions(id, workspace_id) on delete restrict,
  foreign key (action_request_id, workspace_id)
    references public.action_requests(id, workspace_id) on delete restrict
);
create trigger financial_reconciliation_reads_append_only
before update or delete on public.financial_reconciliation_reads
for each row execute function app_private.reject_append_only_change();

create function app_private.protect_financial_transaction()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('app_private.execution_history_purge_workspace', true) = old.workspace_id::text then return old; end if;
    raise exception 'financial transactions are durable execution history' using errcode = '55000';
  end if;
  if (to_jsonb(new) - array['status','committed_at']) is distinct from
     (to_jsonb(old) - array['status','committed_at']) then
    raise exception 'financial transaction identity is immutable' using errcode = '55000';
  end if;
  if not ((old.status = 'unknown' and new.status in ('committed','failed')) or
          (old.status = 'committed' and new.status in ('refunded','cancelled'))) then
    raise exception 'invalid financial transaction transition' using errcode = '55000';
  end if;
  if old.status = 'unknown' and new.status = 'committed' and new.committed_at is null then
    raise exception 'committed financial transaction requires a commit time' using errcode = '55000';
  end if;
  if not (old.status = 'unknown' and new.status = 'committed') and
     new.committed_at is distinct from old.committed_at then
    raise exception 'financial commit time is immutable' using errcode = '55000';
  end if;
  return new;
end;
$$;
revoke all on function app_private.protect_financial_transaction() from public, anon, authenticated;
create trigger financial_transactions_protect before update or delete on public.financial_transactions
for each row execute function app_private.protect_financial_transaction();

create function app_private.validate_financial_transaction_insert()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  action_row public.action_requests%rowtype;
  preflight_row app_private.financial_preflights%rowtype;
  parent_row public.financial_transactions%rowtype;
  merchant_key_value text;
  merchant_origin_value text;
begin
  select * into action_row from public.action_requests
  where id = new.action_request_id and workspace_id = new.workspace_id;
  if not found or action_row.risk <> 'financial' or action_row.status <> 'executing' or
     not exists (
       select 1 from public.approvals ap
       where ap.action_request_id = action_row.id
         and ap.workspace_id = action_row.workspace_id
         and ap.approved and ap.typed_confirmation
         and ap.input_hash = action_row.input_hash
         and ap.semantic_intent_hash = action_row.semantic_intent_hash
         and ap.guard_conditions_hash = action_row.guard_conditions_hash
     ) then
    raise exception 'financial transaction requires an exact typed approved action' using errcode = '23514';
  end if;
  select merchant_key, exact_origin into merchant_key_value, merchant_origin_value
  from public.financial_merchants
  where id = new.merchant_id and workspace_id = new.workspace_id;
  if not found then
    raise exception 'financial transaction merchant is unavailable' using errcode = '23514';
  end if;
  if new.kind = 'purchase' then
    select * into preflight_row from app_private.financial_preflights
    where id = new.preflight_id and workspace_id = new.workspace_id;
    if not found or preflight_row.action_request_id <> new.action_request_id or
       preflight_row.merchant_id <> new.merchant_id or
       preflight_row.payment_alias_id <> new.payment_alias_id or
       preflight_row.total_minor_units <> new.amount_minor_units or
       preflight_row.currency <> new.currency or
       preflight_row.recurring_terms is distinct from new.recurring_terms or
       preflight_row.consumed_at is not null or
       preflight_row.quote_expires_at <= now() or
       action_row.tool_name <> 'finance.sandbox.purchase' or
       action_row.input #>> '{preflight,id}' <> preflight_row.id::text or
       action_row.input #>> '{preflight,preflightHash}' <> preflight_row.preflight_hash or
       action_row.semantic_intent->>'effect' <> 'purchase' or
       action_row.semantic_intent->>'provider' <> 'openinstinct_sandbox' or
       action_row.semantic_intent->>'exactOrigin' <> merchant_origin_value or
       action_row.semantic_intent #>> '{counterparty,id}' <> merchant_key_value or
       action_row.semantic_intent #>> '{amount,currency}' <> new.currency or
       action_row.semantic_intent #>> '{amount,minorUnits}' <> new.amount_minor_units::text or
       action_row.semantic_intent->>'credentialUse' <> 'payment' or
       new.status <> 'committed' then
      raise exception 'purchase transaction does not match its preflight and approval' using errcode = '23514';
    end if;
  else
    select * into parent_row from public.financial_transactions
    where id = new.parent_transaction_id and workspace_id = new.workspace_id
      and kind = 'purchase';
    if not found or parent_row.status <> 'committed' or
       parent_row.merchant_id <> new.merchant_id or
       parent_row.payment_alias_id <> new.payment_alias_id or
       parent_row.amount_minor_units <> new.amount_minor_units or
       parent_row.currency <> new.currency or
       new.recurring_terms is not null or
       action_row.tool_name <> (case when new.kind = 'refund'
         then 'finance.sandbox.refund' else 'finance.sandbox.cancel' end) or
       action_row.input->>'transactionId' <> parent_row.id::text or
       action_row.input->>'operation' <> new.kind or
       action_row.input #>> '{amount,currency}' <> new.currency or
       action_row.input #>> '{amount,minorUnits}' <> new.amount_minor_units::text or
       action_row.semantic_intent->>'effect' <> 'cancel' or
       action_row.semantic_intent->>'provider' <> 'openinstinct_sandbox' or
       action_row.semantic_intent->>'exactOrigin' <> merchant_origin_value or
       action_row.semantic_intent #>> '{counterparty,id}' <> merchant_key_value or
       action_row.semantic_intent #>> '{amount,currency}' <> new.currency or
       action_row.semantic_intent #>> '{amount,minorUnits}' <> new.amount_minor_units::text or
       action_row.semantic_intent->>'credentialUse' <> 'none' or
       new.status <> (case when new.kind = 'refund' then 'refunded' else 'cancelled' end) then
      raise exception 'financial adjustment does not match its parent and approval' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app_private.validate_financial_transaction_insert() from public, anon, authenticated;
create trigger financial_transactions_validate_insert
before insert on public.financial_transactions
for each row execute function app_private.validate_financial_transaction_insert();

create function app_private.validate_spend_ledger_insert()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare transaction_row public.financial_transactions%rowtype;
begin
  select * into transaction_row from public.financial_transactions
  where id = new.transaction_id and workspace_id = new.workspace_id;
  if not found or new.amount_minor_units <> transaction_row.amount_minor_units or
     new.currency <> transaction_row.currency or
     new.entry_type <> (case when transaction_row.kind = 'purchase' then 'debit' else 'credit' end) then
    raise exception 'spend ledger entry does not match its transaction' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function app_private.validate_spend_ledger_insert() from public, anon, authenticated;
create trigger spend_ledger_validate_insert before insert on public.spend_ledger
for each row execute function app_private.validate_spend_ledger_insert();

create function app_private.validate_financial_receipt_insert()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare transaction_row public.financial_transactions%rowtype;
begin
  select * into transaction_row from public.financial_transactions
  where id = new.transaction_id and workspace_id = new.workspace_id;
  if not found or new.safe_summary #>> '{amount,currency}' <> transaction_row.currency or
     new.safe_summary #>> '{amount,minorUnits}' <> transaction_row.amount_minor_units::text then
    raise exception 'financial receipt does not match its transaction' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function app_private.validate_financial_receipt_insert() from public, anon, authenticated;
create trigger financial_receipts_validate_insert before insert on public.financial_receipts
for each row execute function app_private.validate_financial_receipt_insert();

create function app_private.validate_financial_reconciliation_insert()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if not exists (
    select 1 from public.financial_transactions t
    where t.id = new.transaction_id and t.workspace_id = new.workspace_id
      and t.action_request_id = new.action_request_id
      and t.status = new.observed_status
  ) then
    raise exception 'financial reconciliation lineage mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function app_private.validate_financial_reconciliation_insert() from public, anon, authenticated;
create trigger financial_reconciliation_reads_validate_insert
before insert on public.financial_reconciliation_reads
for each row execute function app_private.validate_financial_reconciliation_insert();

create function app_private.require_financial_typed_confirmation()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.approved and not new.typed_confirmation and exists (
    select 1 from public.action_requests a
    where a.id = new.action_request_id and a.workspace_id = new.workspace_id
      and (a.risk = 'financial' or a.semantic_intent->>'effect' = 'purchase')
  ) then
    raise exception 'financial approval requires typed confirmation' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function app_private.require_financial_typed_confirmation() from public, anon, authenticated;
create trigger approvals_require_financial_confirmation
before insert on public.approvals
for each row execute function app_private.require_financial_typed_confirmation();

alter table public.financial_settings enable row level security;
alter table public.financial_merchants enable row level security;
alter table public.payment_aliases enable row level security;
alter table public.financial_transactions enable row level security;
alter table public.spend_ledger enable row level security;
alter table public.financial_receipts enable row level security;
alter table public.financial_reconciliation_reads enable row level security;

revoke all on public.financial_settings, public.financial_merchants,
  public.payment_aliases, public.financial_transactions, public.spend_ledger,
  public.financial_receipts, public.financial_reconciliation_reads from anon, authenticated;
grant select, update on public.financial_settings, public.financial_merchants to authenticated;
grant select, update on public.payment_aliases to authenticated;
grant select on public.financial_transactions, public.spend_ledger,
  public.financial_receipts, public.financial_reconciliation_reads to authenticated;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'financial_settings','financial_merchants','payment_aliases',
    'financial_transactions','spend_ledger','financial_receipts',
    'financial_reconciliation_reads'
  ] loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_user_id = (select auth.uid())))',
      table_name || '_select_owner', table_name
    );
  end loop;
end $$;
create policy financial_settings_update_owner on public.financial_settings
for update to authenticated using (exists (
  select 1 from public.workspaces w where w.id = workspace_id and w.owner_user_id = (select auth.uid())
)) with check (exists (
  select 1 from public.workspaces w where w.id = workspace_id and w.owner_user_id = (select auth.uid())
));
create policy financial_merchants_update_owner on public.financial_merchants
for update to authenticated using (exists (
  select 1 from public.workspaces w where w.id = workspace_id and w.owner_user_id = (select auth.uid())
)) with check (exists (
  select 1 from public.workspaces w where w.id = workspace_id and w.owner_user_id = (select auth.uid())
));
create policy payment_aliases_update_owner on public.payment_aliases
for update to authenticated using (exists (
  select 1 from public.workspaces w where w.id = workspace_id and w.owner_user_id = (select auth.uid())
)) with check (exists (
  select 1 from public.workspaces w where w.id = workspace_id and w.owner_user_id = (select auth.uid())
));

comment on table app_private.financial_preflights is
  'Immutable exact purchase quote snapshots. No Data API role has privileges.';
comment on table public.spend_ledger is
  'Append-only owner-visible financial evidence in integer minor units.';

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
      and (state <> 'deleted' or deletion_recheck_until > now())
  ) then
    raise exception 'artifact bytes and late-write tombstones must be verifiably cleared before workspace purge'
      using errcode = '55000';
  end if;
  if exists (select 1 from app_private.artifact_locations
    where workspace_id = target_workspace_id) then
    raise exception 'artifact byte locations must be removed before workspace purge'
      using errcode = '55000';
  end if;
  if exists (select 1 from public.financial_transactions
    where workspace_id = target_workspace_id and status = 'unknown') then
    raise exception 'unknown financial outcomes must be reconciled before workspace purge'
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
  delete from public.financial_reconciliation_reads where workspace_id = target_workspace_id;
  delete from public.financial_receipts where workspace_id = target_workspace_id;
  delete from public.spend_ledger where workspace_id = target_workspace_id;
  delete from public.financial_transactions where workspace_id = target_workspace_id;
  delete from app_private.financial_preflights where workspace_id = target_workspace_id;
  delete from app_private.payment_alias_handles where workspace_id = target_workspace_id;
  delete from public.payment_aliases where workspace_id = target_workspace_id;
  delete from public.financial_merchants where workspace_id = target_workspace_id;
  delete from public.financial_settings where workspace_id = target_workspace_id;
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
