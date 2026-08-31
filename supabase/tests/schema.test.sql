begin;
select plan(105);

select has_table('public', 'workspaces', 'workspaces table exists');
select has_table('public', 'action_requests', 'action requests table exists');
select has_table('public', 'workflow_steps', 'durable workflow steps table exists');
select has_table('public', 'tool_results', 'structured tool results table exists');
select has_table('public', 'run_events', 'append-only run events table exists');
select has_table('public', 'browser_profile_origins', 'browser origins table exists');
select has_table('app_private', 'browser_control_sessions', 'browser control sessions are private');
select has_table('public', 'browser_executions', 'durable browser executions exist');
select has_table('public', 'browser_handoffs', 'durable owner browser handoffs exist');
select has_table('public', 'artifacts', 'provider-neutral artifact metadata exists');
select has_table('public', 'site_support', 'site support registry exists');
select has_table('app_private', 'browser_execution_handles', 'browser provider handles are private');
select has_table('app_private', 'browser_execution_slices', 'browser observations and decisions are private');
select has_table('app_private', 'browser_handoff_handles', 'browser handoff provider state is private');
select has_table('app_private', 'artifact_locations', 'artifact byte locations are private');
select has_table('app_private', 'worker_heartbeats', 'continuous worker heartbeats are private');
select has_table('pgmq', 'q_agent_jobs', 'durable agent queue exists');
select ok((select relrowsecurity from pg_class where oid = 'public.connections'::regclass), 'connections use RLS');
select ok((select count(*) > 0 from pg_policies where schemaname = 'public' and tablename = 'connections'), 'connections have owner policies');
select ok((select count(*) = 1 from pg_indexes where schemaname = 'public' and indexname = 'workspaces_single_owner_deployment_idx'), 'deployment enforces one owner workspace');
select ok(not has_table_privilege('authenticated', 'public.workspaces', 'INSERT'), 'clients cannot claim workspaces directly');
select ok(not has_table_privilege('authenticated', 'public.connections', 'UPDATE'), 'clients cannot mutate connector security state');
select has_view('public', 'connection_summaries', 'safe connector summaries view exists');
select has_extension('pg_cron', 'Supabase Cron is enabled');
select has_extension('pg_net', 'async HTTP is enabled');
select has_function('app_private', 'invoke_consumer', array[]::text[], 'protected consumer invoker exists');
select has_function('app_private', 'configure_consumer_scheduler', array['text', 'text'], 'scheduler configuration function exists');
select ok(not has_function_privilege('authenticated', 'app_private.invoke_consumer()', 'EXECUTE'), 'clients cannot invoke the scheduler function');
select has_column('public', 'scheduled_triggers', 'recurrence_seconds', 'schedules support recurrence');
select has_column('public', 'scheduled_triggers', 'completed_at', 'schedules record completion');
select has_column('public', 'workflow_steps', 'execution_phase', 'steps record the invocation boundary');
select has_column('public', 'tool_results', 'certainty', 'results record certainty');
select has_column('public', 'tool_results', 'continuation_status', 'results provide a durable continuation outbox');
select has_column('public', 'browser_profiles', 'status', 'browser profiles have lifecycle state');
select has_column('public', 'browser_profiles', 'configuration_version', 'browser policy has a version');
select has_column('public', 'browser_executions', 'max_cost_units', 'browser executions have a provider cost budget');
select has_column('public', 'browser_executions', 'cost_units_used', 'browser executions persist cost-budget use');
select has_column('public', 'artifacts', 'retention_expires_at', 'artifacts have bounded retention');
select ok((select relrowsecurity from pg_class where oid = 'public.scheduled_triggers'::regclass), 'schedules use RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.memories'::regclass), 'memories use RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.workflow_steps'::regclass), 'workflow steps use RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.tool_results'::regclass), 'tool results use RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.run_events'::regclass), 'run events use RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.browser_profile_origins'::regclass), 'browser origins use RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.browser_executions'::regclass), 'browser executions use RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.browser_handoffs'::regclass), 'browser handoffs use RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.artifacts'::regclass), 'artifacts use RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.site_support'::regclass), 'site support uses RLS');
select is(
  (
    select count(*)::integer
    from pg_class
    where oid in (
      'public.workspaces'::regclass,
      'public.owner_phone_numbers'::regclass,
      'public.conversations'::regclass,
      'public.messages'::regclass,
      'public.inbound_events'::regclass,
      'public.agent_runs'::regclass,
      'public.action_requests'::regclass,
      'public.approvals'::regclass,
      'public.connections'::regclass,
      'public.memories'::regclass,
      'public.scheduled_triggers'::regclass,
      'public.audit_events'::regclass,
      'public.browser_profiles'::regclass,
      'public.workflow_steps'::regclass,
      'public.tool_results'::regclass,
      'public.run_events'::regclass
      ,'public.browser_profile_origins'::regclass,
      'public.browser_executions'::regclass,
      'public.browser_handoffs'::regclass,
      'public.artifacts'::regclass,
      'public.site_support'::regclass
    ) and relrowsecurity
  ),
  21,
  'every Data API table has RLS enabled'
);
select ok(
  not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and grantee = 'anon'
  ),
  'anonymous clients have no public table or view grants'
);
select ok(
  not has_column_privilege('authenticated', 'public.browser_profiles', 'provider_profile_id', 'SELECT'),
  'provider profile identifiers are not exposed through the Data API'
);
select ok(
  not has_table_privilege('authenticated', 'public.browser_profiles', 'INSERT')
    and not has_table_privilege('authenticated', 'public.browser_profiles', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.browser_profiles', 'DELETE'),
  'browser lifecycle is server-written'
);
select ok(
  not has_table_privilege('authenticated', 'app_private.browser_control_sessions', 'SELECT'),
  'browser control sessions are unavailable to authenticated clients'
);
select ok(
  not has_table_privilege('authenticated', 'app_private.browser_execution_handles', 'SELECT')
    and not has_table_privilege('authenticated', 'app_private.browser_execution_slices', 'SELECT')
    and not has_table_privilege('authenticated', 'app_private.browser_handoff_handles', 'SELECT')
    and not has_table_privilege('anon', 'app_private.browser_handoff_handles', 'SELECT')
    and not has_table_privilege('service_role', 'app_private.browser_handoff_handles', 'SELECT')
    and not has_table_privilege('authenticated', 'app_private.artifact_locations', 'SELECT')
    and not has_table_privilege('authenticated', 'app_private.artifact_ingest_leases', 'SELECT')
    and not has_table_privilege('service_role', 'app_private.browser_execution_handles', 'SELECT'),
  'provider handles, leases, observations, decisions, and storage paths have no Data API grants'
);
select ok(
  not has_table_privilege('authenticated', 'app_private.worker_heartbeats', 'SELECT')
    and not has_table_privilege('service_role', 'app_private.worker_heartbeats', 'SELECT'),
  'worker heartbeat and queue latency diagnostics have no Data API grants'
);
select ok(
  not has_table_privilege('authenticated', 'public.browser_executions', 'INSERT')
    and not has_table_privilege('authenticated', 'public.browser_handoffs', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.artifacts', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.site_support', 'DELETE'),
  'adaptive browser and artifact truth is server-written'
);
select ok(
  exists (select 1 from pg_indexes where indexname='browser_executions_one_profile_owner_idx')
    and exists (select 1 from pg_indexes where indexname='browser_executions_one_active_run_idx')
    and exists (select 1 from pg_indexes where indexname='browser_execution_handles_lease_idx')
    and exists (select 1 from pg_indexes where indexname='browser_execution_slices_claim_idx'),
  'browser sessions enforce exclusive ownership and indexed fenced recovery'
);
select ok(
  (select not public and file_size_limit = 25000000 from storage.buckets where id='openinstinct-quarantine')
    and (select not public and file_size_limit = 25000000 from storage.buckets where id='openinstinct-artifacts'),
  'artifact and quarantine buckets are private and size bounded'
);
select ok(
  not exists (
    select 1 from pg_policies where schemaname='storage' and tablename='objects'
      and (coalesce(qual,'') || coalesce(with_check,'')) ~ 'openinstinct-(quarantine|artifacts)'
  ),
  'artifact buckets have no authenticated direct-object policy'
);
select ok(
  not has_column_privilege('authenticated', 'public.browser_profiles', 'provider_capabilities', 'SELECT')
    and not has_column_privilege('authenticated', 'public.browser_profiles', 'capabilities_hash', 'SELECT')
    and not has_column_privilege('authenticated', 'public.browser_profiles', 'last_error_code', 'SELECT'),
  'provider diagnostics remain server-only'
);
select ok(
  not has_table_privilege('authenticated', 'public.browser_profile_origins', 'INSERT')
    and not has_table_privilege('authenticated', 'public.browser_profile_origins', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.browser_profile_origins', 'DELETE')
    and not has_table_privilege('anon', 'app_private.browser_control_sessions', 'SELECT')
    and not has_table_privilege('service_role', 'app_private.browser_control_sessions', 'SELECT'),
  'origins are server-written and private sessions have no Data API grants'
);
select ok(
  exists (select 1 from pg_indexes where indexname='browser_control_sessions_one_active_profile_idx')
    and exists (select 1 from pg_indexes where indexname='browser_control_sessions_nonce_idx')
    and exists (select 1 from pg_indexes where indexname='browser_control_sessions_profile_fk_idx'),
  'control sessions enforce exclusive active use and indexed cleanup'
);
select ok(
  not has_table_privilege('authenticated', 'public.connections', 'SELECT'),
  'clients cannot read encrypted connection records directly'
);
select ok(
  not has_table_privilege('authenticated', 'public.agent_runs', 'INSERT'),
  'clients cannot create agent runs directly'
);
select ok(
  not has_table_privilege('authenticated', 'public.workflow_steps', 'INSERT')
    and not has_table_privilege('authenticated', 'public.tool_results', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.run_events', 'DELETE'),
  'execution truth tables are owner-readable but server-written'
);
select ok(
  not has_column_privilege('authenticated', 'public.tool_results', 'output', 'SELECT')
    and not has_column_privilege('authenticated', 'public.tool_results', 'error_message', 'SELECT'),
  'raw result payloads and errors are not exposed through the Data API'
);
select is(
  (
    select count(*)::integer from pg_policies
    where schemaname = 'public'
      and tablename in ('workflow_steps', 'tool_results', 'run_events')
  ),
  3,
  'each execution truth table has one owner-select policy'
);
select is(
  (
    select count(*)::integer from information_schema.triggers
    where trigger_schema = 'public'
      and trigger_name in ('run_events_append_only', 'audit_events_append_only')
  ),
  4,
  'run and audit histories reject direct mutation'
);
select ok(
  exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'action_requests_one_unresolved_per_run_idx'
      and indexdef like '%unknown%'
  ),
  'unknown actions block another unresolved consequential action'
);
select ok(
  exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'tool_results_pending_continuation_idx'
  ),
  'pending continuations have a recovery index'
);
select ok(
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'run_events'
      and column_name = 'sequence' and is_identity = 'YES'
  ),
  'run events use a race-free append sequence'
);

insert into auth.users (id, email)
values ('10000000-0000-4000-8000-000000000001', 'phase0@example.test');
drop index public.workspaces_single_owner_deployment_idx;
insert into auth.users (id, email)
values ('10000000-0000-4000-8000-000000000011', 'phase0-other@example.test');
insert into public.workspaces (id, owner_user_id)
values (
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000001'
);
insert into public.workspaces (id, owner_user_id)
values (
  '10000000-0000-4000-8000-000000000012',
  '10000000-0000-4000-8000-000000000011'
);
insert into public.agent_runs (id, workspace_id, status)
values (
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000002',
  'running'
);
insert into public.browser_profiles (
  id,workspace_id,provider,provider_profile_id,label,status
) values (
  '10000000-0000-4000-8000-000000000020',
  '10000000-0000-4000-8000-000000000002',
  'kernel','provider-secret-reference','Canary','active'
);
insert into public.browser_profile_origins (profile_id,workspace_id,origin)
values (
  '10000000-0000-4000-8000-000000000020',
  '10000000-0000-4000-8000-000000000002','https://example.test'
);
select throws_ok(
  $$insert into public.browser_profile_origins (profile_id,workspace_id,origin)
    values ('10000000-0000-4000-8000-000000000020',
      '10000000-0000-4000-8000-000000000002','https://example.test/path')$$,
  '23514', null, 'browser origins must be exact HTTPS origins'
);
select throws_ok(
  $$insert into public.browser_profile_origins (profile_id,workspace_id,origin)
    values ('10000000-0000-4000-8000-000000000020',
      '10000000-0000-4000-8000-000000000012','https://other.example.test')$$,
  '23503', null, 'browser origins cannot cross workspace bindings'
);
select throws_ok(
  $$update public.browser_profiles set status='revoked'
    where id='10000000-0000-4000-8000-000000000020'$$,
  '23514', null, 'revoked browser profiles require a revocation timestamp'
);
select throws_ok(
  $$update public.browser_profiles set deletion_requested_at=now()
    where id='10000000-0000-4000-8000-000000000020'$$,
  '23514', null, 'active browser profiles cannot enter deletion state'
);
select throws_ok(
  $$insert into app_private.browser_control_sessions (
      id,profile_id,workspace_id,provider_session_id,purpose,status,
      takeover_nonce_hash,configuration_version,expires_at
    ) values (
      '10000000-0000-4000-8000-000000000021',
      '10000000-0000-4000-8000-000000000020',
      '10000000-0000-4000-8000-000000000002','expired-provider-session',
      'health','active',repeat('9',64),1,now()-interval '1 minute'
    )$$,
  '23514', null, 'browser control sessions must expire after creation'
);
insert into app_private.browser_control_sessions (
  id,profile_id,workspace_id,provider_session_id,purpose,status,
  takeover_nonce_hash,configuration_version,expires_at
) values (
  '10000000-0000-4000-8000-000000000022',
  '10000000-0000-4000-8000-000000000020',
  '10000000-0000-4000-8000-000000000002','active-provider-session',
  'health','active',repeat('8',64),1,now()+interval '10 minutes'
);
update app_private.browser_control_sessions set status='cleanup_pending'
where id='10000000-0000-4000-8000-000000000022';
select throws_ok(
  $$insert into app_private.browser_control_sessions (
      profile_id,workspace_id,provider_session_id,purpose,status,
      takeover_nonce_hash,configuration_version,expires_at
    ) values (
      '10000000-0000-4000-8000-000000000020',
      '10000000-0000-4000-8000-000000000002','second-provider-session',
      'takeover','active',repeat('7',64),1,now()+interval '10 minutes'
    )$$,
  '23505', null, 'cleanup-pending provider sessions retain exclusive profile ownership'
);
insert into public.run_events (
  id, workspace_id, run_id, event_type, event_key, payload, payload_hash
) values (
  '10000000-0000-4000-8000-000000000004',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  'run_started', 'fixture:run_started', '{}', repeat('a', 64)
);
insert into public.audit_events (
  id, workspace_id, actor, action, detail, run_id, event_key, detail_hash
) values (
  '10000000-0000-4000-8000-000000000005',
  '10000000-0000-4000-8000-000000000002',
  'worker', 'run.started', '{}',
  '10000000-0000-4000-8000-000000000003',
  'fixture:audit', repeat('b', 64)
);

select throws_ok(
  $$update public.run_events set payload = '{"changed":true}' where event_key = 'fixture:run_started'$$,
  '55000', 'run_events is append-only',
  'run events reject updates'
);
select throws_ok(
  $$delete from public.run_events where event_key = 'fixture:run_started'$$,
  '55000', 'run_events is append-only',
  'run events reject deletes'
);
select throws_ok(
  $$update public.audit_events set detail = '{"changed":true}' where event_key = 'fixture:audit'$$,
  '55000', 'audit_events is append-only',
  'audit events reject updates'
);
select throws_ok(
  $$delete from public.audit_events where event_key = 'fixture:audit'$$,
  '55000', 'audit_events is append-only',
  'audit events reject deletes'
);

insert into public.action_requests (
  id, workspace_id, run_id, tool_name, risk, summary, input, input_hash,
  status, expires_at
) values (
  '10000000-0000-4000-8000-000000000006',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  'fixture.write', 'write', 'first', '{}', repeat('c', 64),
  'pending', now() + interval '1 hour'
);
select throws_ok(
  $$insert into public.action_requests (
      id, workspace_id, run_id, tool_name, risk, summary, input, input_hash,
      status, expires_at
    ) values (
      '10000000-0000-4000-8000-000000000013',
      '10000000-0000-4000-8000-000000000012',
      '10000000-0000-4000-8000-000000000003',
      'fixture.write', 'write', 'cross workspace', '{}', repeat('1', 64),
      'executed', now() + interval '1 hour'
    )$$,
  '23503', null,
  'action requests cannot cross workspace and run lineage'
);
select throws_ok(
  $$insert into public.approvals (
      workspace_id, action_request_id, approved, input_hash, channel
    ) values (
      '10000000-0000-4000-8000-000000000012',
      '10000000-0000-4000-8000-000000000006',
      true, repeat('c', 64), 'fixture'
    )$$,
  '23503', null,
  'approvals cannot cross workspace and action lineage'
);
select throws_ok(
  $$insert into public.action_requests (
      id, workspace_id, run_id, tool_name, risk, summary, input, input_hash,
      status, expires_at
    ) values (
      '10000000-0000-4000-8000-000000000007',
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000003',
      'fixture.write', 'write', 'second', '{}', repeat('d', 64),
      'pending', now() + interval '1 hour'
    )$$,
  '23505', null,
  'a run cannot hold two unresolved consequential actions'
);
update public.action_requests
set status = 'executed'
where id = '10000000-0000-4000-8000-000000000006';
select lives_ok(
  $$insert into public.action_requests (
      id, workspace_id, run_id, tool_name, risk, summary, input, input_hash,
      status, expires_at
    ) values (
      '10000000-0000-4000-8000-000000000007',
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000003',
      'fixture.write', 'write', 'second', '{}', repeat('d', 64),
      'pending', now() + interval '1 hour'
    )$$,
  'a terminal action permits the next sequential action'
);
update public.action_requests
set status = 'executed'
where id = '10000000-0000-4000-8000-000000000007';

insert into public.workflow_steps (
  id, workspace_id, run_id, action_request_id, position, kind, tool_name,
  status, input, input_hash
) values (
  '10000000-0000-4000-8000-000000000008',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000006',
  0, 'action', 'fixture.write', 'running', '{}', repeat('e', 64)
);
insert into public.browser_executions (
  id,workspace_id,run_id,step_id,profile_id,profile_configuration_version,
  mode,status,goal_hash,
  policy_hash,max_steps,max_duration_seconds,max_cost_units
) values (
  '10000000-0000-4000-8000-000000000030',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000008',
  '10000000-0000-4000-8000-000000000020',
  (select configuration_version from public.browser_profiles
    where id='10000000-0000-4000-8000-000000000020'),
  'persistent_read_only','queued',repeat('a',64),repeat('b',64),3,300,3
);
insert into app_private.browser_execution_handles (
  execution_id,workspace_id,provider,correlation_id,allowed_origins,start_url,goal
) values (
  '10000000-0000-4000-8000-000000000030',
  '10000000-0000-4000-8000-000000000002','kernel',
  '10000000-0000-4000-8000-000000000031','["https://example.test"]',
  'https://example.test/','Read the public page'
);
insert into app_private.browser_execution_slices (
  id,execution_id,workspace_id,ordinal,status
) values (
  '10000000-0000-4000-8000-000000000032',
  '10000000-0000-4000-8000-000000000030',
  '10000000-0000-4000-8000-000000000002',0,'queued'
);
insert into public.browser_handoffs (
  id,workspace_id,execution_id,status,reason_code,expires_at
) values (
  '10000000-0000-4000-8000-000000000037',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000030','requested','fixture_owner_required',
  now()+interval '10 minutes'
);
insert into app_private.browser_handoff_handles (
  handoff_id,workspace_id,provider_session_id
) values (
  '10000000-0000-4000-8000-000000000037',
  '10000000-0000-4000-8000-000000000002','fixture-provider-session'
);
select throws_ok(
  $$update app_private.browser_execution_handles
    set lease_token_hash=repeat('f',64)
    where execution_id='10000000-0000-4000-8000-000000000030'$$,
  '23514', null, 'browser leases require both a token hash and expiry'
);
insert into public.artifacts (
  id,workspace_id,browser_execution_id,step_id,kind,sensitivity,state,
  display_name,declared_mime_type
) values (
  '10000000-0000-4000-8000-000000000036',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000030',
  '10000000-0000-4000-8000-000000000008',
  'screenshot','sensitive','pending_upload','masked.png','image/png'
);
select throws_ok(
  $$update public.artifacts set state='available'
    where id='10000000-0000-4000-8000-000000000036'$$,
  '23514', null, 'available artifacts require scan metadata and availability time'
);
insert into public.agent_runs (id,workspace_id,status)
values (
  '10000000-0000-4000-8000-000000000033',
  '10000000-0000-4000-8000-000000000002','queued'
);
insert into public.workflow_steps (
  id,workspace_id,run_id,position,kind,tool_name,status,input,input_hash
) values (
  '10000000-0000-4000-8000-000000000034',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000033',0,'tool','browser.research',
  'running','{}',repeat('c',64)
);
select throws_ok(
  $$insert into public.browser_executions (
      id,workspace_id,run_id,step_id,profile_id,profile_configuration_version,
      mode,status,goal_hash,
      policy_hash,max_steps,max_duration_seconds,max_cost_units
    ) values (
      '10000000-0000-4000-8000-000000000035',
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000033',
      '10000000-0000-4000-8000-000000000034',
      '10000000-0000-4000-8000-000000000020',
      (select configuration_version from public.browser_profiles
        where id='10000000-0000-4000-8000-000000000020'),
      'persistent_read_only','queued',repeat('d',64),repeat('e',64),3,300,3
    )$$,
  '23505', null, 'a persistent profile has one exclusive execution owner'
);
select throws_ok(
  $$insert into public.tool_results (
      workspace_id, run_id, step_id, tool_name, certainty, attempt,
      result_hash, started_at, completed_at
    ) values (
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000008',
      'fixture.write', 'maybe', 1, repeat('f', 64), now(), now()
    )$$,
  '23514', null,
  'tool results reject unknown certainty values'
);
select throws_ok(
  $$insert into public.audit_events (
      workspace_id, actor, action, detail, workflow_step_id, event_key, detail_hash
    ) values (
      '10000000-0000-4000-8000-000000000002', 'worker', 'fixture.invalid', '{}',
      '10000000-0000-4000-8000-000000000008', 'fixture:audit:missing-run', repeat('2', 64)
    )$$,
  '23514', null,
  'audit step lineage requires a run identifier'
);
select throws_ok(
  $$insert into public.tool_results (
      workspace_id, run_id, step_id, reconciles_result_id, tool_name,
      certainty, attempt, output, output_hash, result_hash, started_at, completed_at
    ) values (
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000008',
      '10000000-0000-4000-8000-000000000099',
      'reconciliation.read', 'reconciled_succeeded', 2, '{}', repeat('3', 64),
      repeat('4', 64), now(), now()
    )$$,
  '23514', 'reconciliation must reference an unknown result',
  'reconciliation cannot reference a non-unknown result'
);
select throws_ok(
  $$delete from public.agent_runs where id = '10000000-0000-4000-8000-000000000003'$$,
  '23503', null,
  'selective parent deletion cannot erase execution history'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000001',
  true
);
select is(
  (select count(*)::integer from public.run_events),
  1,
  'the authenticated owner can read execution history'
);
select is(
  (select count(*)::integer from public.browser_profile_summaries),
  1,
  'the owner can read safe browser profile summaries'
);
select is(
  (select count(*)::integer from public.browser_executions),
  1,
  'the owner can read safe browser execution summaries'
);
select is(
  (select count(*)::integer from public.browser_handoffs),
  1,
  'the owner can read safe browser handoff state'
);
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000099',
  true
);
select is(
  (select count(*)::integer from public.run_events),
  0,
  'another authenticated identity cannot read execution history'
);
select is(
  (select count(*)::integer from public.browser_profile_summaries),
  0,
  'another identity cannot read browser profile summaries'
);
select is(
  (select count(*)::integer from public.browser_executions),
  0,
  'another identity cannot read browser execution summaries'
);
select is(
  (select count(*)::integer from public.browser_handoffs),
  0,
  'another identity cannot read browser handoff state'
);
reset role;

set local role service_role;
select throws_ok(
  $$select app_private.purge_workspace_execution_history(
      '10000000-0000-4000-8000-000000000002'
    )$$,
  '55000',
  'provider browser profiles must be verifiably deleted before workspace purge',
  'workspace purge refuses undeleted provider profiles'
);
reset role;

update public.browser_executions set status='failed',completed_at=now(),
  last_error_code='fixture_profile_released'
where id='10000000-0000-4000-8000-000000000030';
update public.browser_profiles set status='revoked',revoked_at=now(),
  deletion_requested_at=now(),deletion_verified_at=now()
where id='10000000-0000-4000-8000-000000000020';
delete from public.browser_profiles
where id='10000000-0000-4000-8000-000000000020';

insert into public.browser_executions (
  id,workspace_id,run_id,step_id,mode,status,goal_hash,policy_hash,
  max_steps,max_duration_seconds,max_cost_units
) values (
  '10000000-0000-4000-8000-000000000035',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000033',
  '10000000-0000-4000-8000-000000000034',
  'ephemeral_read_only','queued',repeat('d',64),repeat('e',64),3,300,3
);

set local role service_role;
select throws_ok(
  $$select app_private.purge_workspace_execution_history(
      '10000000-0000-4000-8000-000000000002'
    )$$,
  '55000',
  'browser executions must reach a verified terminal state before workspace purge',
  'workspace purge refuses a nonterminal browser execution'
);
reset role;
update public.browser_executions set status='failed',completed_at=now(),
  last_error_code='fixture_terminal'
where id='10000000-0000-4000-8000-000000000035';
set local role service_role;
select throws_ok(
  $$select app_private.purge_workspace_execution_history(
      '10000000-0000-4000-8000-000000000002'
    )$$,
  '55000',
  'artifact bytes and late-write tombstones must be verifiably cleared before workspace purge',
  'workspace purge refuses artifact metadata until byte deletion is verified'
);
reset role;
update public.artifacts set state='deleted',deletion_requested_at=now(),
  deletion_verified_at=now()
where id='10000000-0000-4000-8000-000000000036';

update public.action_requests set status = 'unknown'
where id = '10000000-0000-4000-8000-000000000006';
insert into public.tool_results (
  id, workspace_id, run_id, step_id, action_request_id, tool_name, certainty,
  attempt, error_code, result_hash, continuation_status,
  continuation_enqueued_at, started_at, completed_at
) values (
  '10000000-0000-4000-8000-000000000018',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000008',
  '10000000-0000-4000-8000-000000000006',
  'fixture.write', 'unknown', 1, 'fixture_unknown', repeat('5', 64),
  'enqueued', now(), now(), now()
);
insert into public.workflow_steps (
  id, workspace_id, run_id, position, kind, tool_name, status,
  execution_phase, input, input_hash, attempt, started_at, completed_at
) values (
  '10000000-0000-4000-8000-000000000019',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  1, 'reconciliation', 'reconciliation.read', 'succeeded',
  'result_persisted', '{}', repeat('6', 64), 1, now(), now()
);
insert into public.tool_results (
  workspace_id, run_id, step_id, reconciles_result_id, tool_name, certainty,
  attempt, output, output_hash, result_hash, continuation_status,
  continuation_enqueued_at, started_at, completed_at
) values (
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000019',
  '10000000-0000-4000-8000-000000000018',
  'reconciliation.read', 'reconciled_succeeded', 1, '{}', repeat('7', 64),
  repeat('8', 64), 'enqueued', now(), now(), now()
);
set local role service_role;
select lives_ok(
  $$select app_private.purge_workspace_execution_history(
      '10000000-0000-4000-8000-000000000002'
    )$$,
  'trusted full-workspace decommission can purge append-only history'
);
reset role;
select is(
  (
    select count(*)::integer from public.workspaces
    where id = '10000000-0000-4000-8000-000000000002'
  ),
  0,
  'full-workspace decommission removes the workspace'
);

select * from finish();
rollback;
