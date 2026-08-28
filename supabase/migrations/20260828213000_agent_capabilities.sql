alter table public.scheduled_triggers
  add column recurrence_seconds bigint,
  add column updated_at timestamptz not null default now(),
  add column completed_at timestamptz,
  add constraint scheduled_triggers_recurrence_bounds
    check (recurrence_seconds is null or recurrence_seconds between 60 and 31557600);

create trigger scheduled_triggers_updated
before update on public.scheduled_triggers
for each row execute function app_private.set_updated_at();

create index scheduled_triggers_workspace_status_idx
on public.scheduled_triggers (workspace_id, status, run_at);

comment on column public.scheduled_triggers.payload is
  'Bounded schedule payload. reminder uses message and conversationId; routine uses prompt and conversationId.';
