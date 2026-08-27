create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pgmq;
create extension if not exists vector with schema extensions;

create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null unique references auth.users(id) on delete cascade,
  display_name text not null default 'My OpenInstinct',
  timezone text not null default 'UTC',
  quiet_hours_start smallint not null default 22 check (quiet_hours_start between 0 and 23),
  quiet_hours_end smallint not null default 8 check (quiet_hours_end between 0 and 23),
  max_proactive_messages_per_day smallint not null default 5 check (max_proactive_messages_per_day between 0 and 50),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index workspaces_single_owner_deployment_idx on public.workspaces ((true));

create table public.owner_phone_numbers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references public.workspaces(id) on delete cascade,
  phone_e164 text not null unique check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  verified_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null,
  provider_chat_id text not null,
  contact_address text,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, provider, provider_chat_id)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  provider_message_id text,
  role text not null check (role in ('user', 'assistant', 'tool', 'system')),
  direction text not null check (direction in ('inbound', 'outbound', 'internal')),
  content text not null default '',
  status text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (workspace_id, provider_message_id)
);

create table public.inbound_events (
  id text primary key,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  source text not null,
  type text not null,
  occurred_at timestamptz not null,
  payload jsonb not null,
  processed_at timestamptz,
  processing_error text,
  created_at timestamptz not null default now()
);

create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  trigger_event_id text references public.inbound_events(id) on delete set null,
  status text not null default 'queued' check (status in ('queued', 'running', 'waiting_approval', 'waiting_event', 'completed', 'failed', 'cancelled')),
  waiting_for text,
  attempt integer not null default 0,
  model text,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  last_error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.action_requests (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  tool_name text not null,
  risk text not null check (risk in ('read', 'write', 'communicate', 'financial', 'destructive', 'security')),
  summary text not null,
  input jsonb not null,
  input_hash text not null check (length(input_hash) = 64),
  status text not null default 'pending' check (status in ('pending', 'approved', 'executing', 'executed', 'denied', 'expired', 'failed', 'unknown')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  action_request_id uuid not null unique references public.action_requests(id) on delete cascade,
  approved boolean not null,
  input_hash text not null check (length(input_hash) = 64),
  channel text not null,
  reason text,
  decided_at timestamptz not null default now()
);

create table public.connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null,
  account_id text,
  display_name text,
  scopes text[] not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'active', 'expired', 'revoked', 'error')),
  encrypted_credentials text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, provider, account_id)
);

create view public.connection_summaries
with (security_invoker = true)
as select id, workspace_id, provider, account_id, display_name, scopes, status, created_at, updated_at
from public.connections;

create table public.memories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null check (kind in ('profile', 'episodic', 'commitment', 'open_loop', 'preference')),
  content text not null,
  source_type text not null,
  source_id text,
  confidence real not null default 1 check (confidence between 0 and 1),
  sensitivity text not null default 'personal' check (sensitivity in ('public', 'personal', 'sensitive')),
  confirmed_at timestamptz,
  expires_at timestamptz,
  embedding extensions.vector(1536),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.scheduled_triggers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  run_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'queued', 'completed', 'cancelled')),
  created_at timestamptz not null default now()
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor text not null,
  action text not null,
  target_type text,
  target_id text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.browser_profiles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null,
  provider_profile_id text not null,
  label text not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, provider, provider_profile_id)
);

create index conversations_workspace_updated_idx on public.conversations (workspace_id, updated_at desc);
create index messages_conversation_created_idx on public.messages (conversation_id, created_at);
create index inbound_events_pending_idx on public.inbound_events (created_at) where processed_at is null;
create index agent_runs_workspace_updated_idx on public.agent_runs (workspace_id, updated_at desc);
create index action_requests_pending_idx on public.action_requests (workspace_id, created_at) where status = 'pending';
create unique index action_requests_one_active_per_run_idx on public.action_requests (run_id)
where status in ('pending', 'approved', 'executing');
create index memories_workspace_kind_idx on public.memories (workspace_id, kind, updated_at desc);
create index scheduled_triggers_due_idx on public.scheduled_triggers (run_at) where status = 'scheduled';

create function app_private.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
revoke all on function app_private.set_updated_at() from public, anon, authenticated;

create trigger workspaces_updated before update on public.workspaces for each row execute function app_private.set_updated_at();
create trigger conversations_updated before update on public.conversations for each row execute function app_private.set_updated_at();
create trigger agent_runs_updated before update on public.agent_runs for each row execute function app_private.set_updated_at();
create trigger action_requests_updated before update on public.action_requests for each row execute function app_private.set_updated_at();
create trigger connections_updated before update on public.connections for each row execute function app_private.set_updated_at();
create trigger memories_updated before update on public.memories for each row execute function app_private.set_updated_at();

select pgmq.create('agent_jobs');

alter table public.workspaces enable row level security;
alter table public.owner_phone_numbers enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.inbound_events enable row level security;
alter table public.agent_runs enable row level security;
alter table public.action_requests enable row level security;
alter table public.approvals enable row level security;
alter table public.connections enable row level security;
alter table public.memories enable row level security;
alter table public.scheduled_triggers enable row level security;
alter table public.audit_events enable row level security;
alter table public.browser_profiles enable row level security;

revoke all on all tables in schema public from anon, authenticated;
grant select on public.workspaces to authenticated;
grant select on public.owner_phone_numbers to authenticated;
grant select on public.conversations, public.messages, public.inbound_events, public.agent_runs, public.audit_events to authenticated;
grant select on public.action_requests to authenticated;
grant select on public.approvals to authenticated;
grant select on public.connection_summaries to authenticated;
grant select, insert, update, delete on public.memories, public.scheduled_triggers, public.browser_profiles to authenticated;

create policy workspaces_select_owner on public.workspaces for select to authenticated using ((select auth.uid()) = owner_user_id);
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'owner_phone_numbers', 'conversations', 'messages', 'inbound_events',
    'agent_runs', 'action_requests', 'approvals', 'connections', 'memories',
    'scheduled_triggers', 'audit_events', 'browser_profiles'
  ] loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_user_id = (select auth.uid())))',
      table_name || '_select_owner', table_name
    );
  end loop;
end $$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array['memories', 'scheduled_triggers', 'browser_profiles'] loop
    execute format('create policy %I on public.%I for insert to authenticated with check (exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_user_id = (select auth.uid())))', table_name || '_insert_owner', table_name);
    execute format('create policy %I on public.%I for update to authenticated using (exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_user_id = (select auth.uid()))) with check (exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_user_id = (select auth.uid())))', table_name || '_update_owner', table_name);
    execute format('create policy %I on public.%I for delete to authenticated using (exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_user_id = (select auth.uid())))', table_name || '_delete_owner', table_name);
  end loop;
end $$;
