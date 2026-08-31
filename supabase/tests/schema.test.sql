begin;
select plan(74);

select has_table('public', 'workspaces', 'workspaces table exists');
select has_table('public', 'action_requests', 'action requests table exists');
select has_table('public', 'workflow_steps', 'durable workflow steps table exists');
select has_table('public', 'tool_results', 'structured tool results table exists');
select has_table('public', 'run_events', 'append-only run events table exists');
select has_table('public', 'browser_profile_origins', 'browser origins table exists');
select has_table('app_private', 'browser_control_sessions', 'browser control sessions are private');
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
select ok((select relrowsecurity from pg_class where oid = 'public.scheduled_triggers'::regclass), 'schedules use RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.memories'::regclass), 'memories use RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.workflow_steps'::regclass), 'workflow steps use RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.tool_results'::regclass), 'tool results use RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.run_events'::regclass), 'run events use RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.browser_profile_origins'::regclass), 'browser origins use RLS');
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
      ,'public.browser_profile_origins'::regclass
    ) and relrowsecurity
  ),
  17,
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

update public.browser_profiles set status='revoked',revoked_at=now(),
  deletion_requested_at=now(),deletion_verified_at=now()
where id='10000000-0000-4000-8000-000000000020';
delete from public.browser_profiles
where id='10000000-0000-4000-8000-000000000020';

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
