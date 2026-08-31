begin;
select plan(174);

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
select has_table('public', 'authority_grants', 'versioned authority grants exist');
select has_table('public', 'authority_usages', 'authority usage reservations exist');
select has_table('public', 'action_evidence', 'action evidence metadata exists');
select has_table('public', 'reconciliation_cases', 'durable reconciliation cases exist');
select has_table('app_private', 'action_evidence_payloads', 'redacted evidence facts are private');
select has_table('app_private', 'reconciliation_claims', 'reconciliation leases are private');
select has_table('public', 'credential_items', 'credential metadata exists');
select has_table('public', 'credential_access_events', 'credential access audit exists');
select has_table('public', 'credential_profile_bindings', 'credential profile bindings exist');
select has_table('app_private', 'credential_secrets', 'credential ciphertext is private');
select has_table('app_private', 'credential_injection_leases', 'credential injection leases are private');
select ok(
  (select convalidated from pg_constraint
    where conname = 'workflow_steps_reconciliation_input_is_safe'),
  'reconciliation input privacy constraint is validated after legacy backfill'
);
select ok(
  not exists (
    select 1 from public.workflow_steps
    where kind = 'reconciliation' and
      (input ?| array['evidence','facts','payload','redactedFacts'] or
       input - array['caseId','unknownResultId','evidenceHash','safeSummary'] <> '{}'::jsonb)
  ),
  'migrated reconciliation steps expose only bounded public metadata'
);
select has_table('app_private', 'browser_execution_handles', 'browser provider handles are private');
select has_table('app_private', 'browser_execution_slices', 'browser observations and decisions are private');
select has_table('app_private', 'browser_handoff_handles', 'browser handoff provider state is private');
select has_table('app_private', 'artifact_locations', 'artifact byte locations are private');
select has_table('app_private', 'worker_heartbeats', 'continuous worker heartbeats are private');
select has_table('pgmq', 'q_agent_jobs', 'durable agent queue exists');
select ok((select relrowsecurity from pg_class where oid = 'public.connections'::regclass), 'connections use RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.credential_items'::regclass), 'credential items use RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.credential_access_events'::regclass), 'credential access events use RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.credential_profile_bindings'::regclass), 'credential profile bindings use RLS');
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
select has_column('public', 'action_requests', 'semantic_intent', 'actions persist semantic intent');
select has_column('public', 'action_requests', 'guard_conditions_hash', 'actions bind guard conditions');
select has_column('public', 'approvals', 'semantic_intent_hash', 'approvals bind semantic intent');
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
select ok((select relrowsecurity from pg_class where oid = 'public.authority_grants'::regclass), 'authority grants use RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.authority_usages'::regclass), 'authority usages use RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.action_evidence'::regclass), 'action evidence uses RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.reconciliation_cases'::regclass), 'reconciliation cases use RLS');
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
      'public.site_support'::regclass,
      'public.authority_grants'::regclass,
      'public.authority_usages'::regclass,
      'public.action_evidence'::regclass,
      'public.reconciliation_cases'::regclass
    ) and relrowsecurity
  ),
  25,
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
  not has_table_privilege('authenticated', 'public.authority_grants', 'INSERT')
    and not has_table_privilege('authenticated', 'public.authority_grants', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.authority_usages', 'INSERT')
    and not has_table_privilege('authenticated', 'public.action_evidence', 'INSERT')
    and not has_table_privilege('authenticated', 'public.reconciliation_cases', 'UPDATE'),
  'semantic authority and evidence tables are server-written'
);
select ok(
  not has_table_privilege('authenticated', 'app_private.action_evidence_payloads', 'SELECT')
    and not has_table_privilege('service_role', 'app_private.action_evidence_payloads', 'SELECT')
    and not has_table_privilege('authenticated', 'app_private.reconciliation_claims', 'SELECT')
    and not has_table_privilege('service_role', 'app_private.reconciliation_claims', 'SELECT'),
  'evidence payloads and reconciliation leases have no Data API grants'
);
select ok(
  not has_table_privilege('authenticated', 'public.credential_items', 'INSERT')
    and not has_table_privilege('authenticated', 'public.credential_access_events', 'INSERT')
    and not has_table_privilege('authenticated', 'public.credential_profile_bindings', 'UPDATE'),
  'credential metadata and audit are server-written'
);
select ok(
  not has_table_privilege('authenticated', 'app_private.credential_secrets', 'SELECT')
    and not has_table_privilege('service_role', 'app_private.credential_secrets', 'SELECT')
    and not has_table_privilege('authenticated', 'app_private.credential_injection_leases', 'SELECT')
    and not has_table_privilege('service_role', 'app_private.credential_injection_leases', 'SELECT'),
  'credential ciphertext and injection leases have no Data API grants'
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
  $$insert into public.credential_items (
      workspace_id,kind,label,allowed_origins,status,configuration_version,
      encryption_key_version
    ) values (
      '10000000-0000-4000-8000-000000000002','website_password','Invalid',
      array['https://example.test/login'],'needs_verification',repeat('c',64),1
    )$$,
  '23514', null,
  'credential origins must be exact HTTPS origins'
);
insert into public.credential_items (
  id,workspace_id,kind,label,username_hint,allowed_origins,status,
  configuration_version,encryption_key_version
) values (
  '10000000-0000-4000-8000-000000000050',
  '10000000-0000-4000-8000-000000000002','website_password','Canary login',
  'o***@example.test',array['https://example.test'],'needs_verification',
  repeat('c',64),1
);
insert into app_private.credential_item_versions (
  credential_item_id,workspace_id,configuration_version,record_version,
  allowed_origins
) values (
  '10000000-0000-4000-8000-000000000050',
  '10000000-0000-4000-8000-000000000002',repeat('c',64),1,
  array['https://example.test']
);
select throws_ok(
  $$insert into app_private.credential_secrets (
      credential_item_id,workspace_id,record_version,envelope
    ) values (
      '10000000-0000-4000-8000-000000000050',
      '10000000-0000-4000-8000-000000000002',1,
      jsonb_build_object(
        'version',1,'keyVersion',2,'wrappedKeyNonce',repeat('A',16),
        'wrappedKeyTag',repeat('A',16),'wrappedKeyCiphertext',repeat('B',32),
        'payloadNonce',repeat('A',16),'payloadTag',repeat('A',16),
        'payloadCiphertext','C'
      )
    )$$,
  '23514', 'credential envelope does not match active metadata',
  'credential envelope key version must match metadata'
);
select lives_ok(
  $$insert into app_private.credential_secrets (
      credential_item_id,workspace_id,record_version,envelope
    ) values (
      '10000000-0000-4000-8000-000000000050',
      '10000000-0000-4000-8000-000000000002',1,
      jsonb_build_object(
        'version',1,'keyVersion',1,'wrappedKeyNonce',repeat('A',16),
        'wrappedKeyTag',repeat('A',16),'wrappedKeyCiphertext',repeat('B',32),
        'payloadNonce',repeat('A',16),'payloadTag',repeat('A',16),
        'payloadCiphertext','C'
      )
    )$$,
  'matching private credential envelope is accepted'
);
select throws_ok(
  $$update app_private.credential_secrets
    set envelope=jsonb_set(envelope,'{payloadCiphertext}','"D"'::jsonb)
    where credential_item_id='10000000-0000-4000-8000-000000000050'$$,
  '55000', 'credential payload and record version must advance together',
  'credential payload cannot change without a new record version'
);
insert into public.browser_profiles (
  id,workspace_id,provider,provider_profile_id,label,status
) values (
  '10000000-0000-4000-8000-000000000021',
  '10000000-0000-4000-8000-000000000002',
  'kernel','credential-injection-profile','Credential injection','needs_login'
);
insert into public.browser_profile_origins (profile_id,workspace_id,origin)
values (
  '10000000-0000-4000-8000-000000000021',
  '10000000-0000-4000-8000-000000000002','https://example.test'
);
insert into app_private.browser_control_sessions (
  id,profile_id,workspace_id,provider_session_id,purpose,status,
  configuration_version,expires_at
) values (
  '10000000-0000-4000-8000-000000000052',
  '10000000-0000-4000-8000-000000000021',
  '10000000-0000-4000-8000-000000000002','credential-session',
  'reauthentication','active',1,now()+interval '5 minutes'
);
select lives_ok(
  $$insert into app_private.credential_injection_leases (
      id,workspace_id,credential_item_id,credential_configuration_version,
      browser_profile_id,browser_profile_configuration_version,
      control_session_id,exact_origin,field_binding_hash,claim_token_hash,
      expires_at
    ) values (
      '10000000-0000-4000-8000-000000000053',
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000050',repeat('c',64),
      '10000000-0000-4000-8000-000000000021',1,
      '10000000-0000-4000-8000-000000000052','https://example.test',
      repeat('d',64),repeat('e',64),now()+interval '2 minutes'
    )$$,
  'a current exact-origin credential injection lease is accepted'
);
select throws_ok(
  $$update app_private.credential_injection_leases
    set status='injected',completed_at=now()
    where id='10000000-0000-4000-8000-000000000053'$$,
  '55000', 'invalid credential injection lease transition',
  'credential injection cannot skip the invocation fence'
);
insert into public.credential_access_events (
  id,workspace_id,credential_item_id,executor,exact_origin,browser_profile_id,
  reason_code,result
) values (
  '10000000-0000-4000-8000-000000000051',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000050','system',
  'https://example.test','10000000-0000-4000-8000-000000000020',
  'fixture_created','requested'
);
select throws_ok(
  $$update public.credential_access_events set result='failed'
    where id='10000000-0000-4000-8000-000000000051'$$,
  '55000', 'credential_access_events is append-only',
  'credential access audit rejects updates'
);
select throws_ok(
  $$delete from public.credential_access_events
    where id='10000000-0000-4000-8000-000000000051'$$,
  '55000', 'credential_access_events is append-only',
  'credential access audit rejects deletes'
);
select throws_ok(
  $$insert into public.credential_access_events (
      workspace_id,credential_item_id,executor,browser_profile_id,
      browser_control_session_id,reason_code,result
    ) values (
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000050','system',
      '10000000-0000-4000-8000-000000000020',
      '10000000-0000-4000-8000-000000000052','fixture_mismatch','requested'
    )$$,
  '23514', 'credential access control-session lineage mismatch',
  'credential access events reject mismatched control-session profiles'
);
select throws_ok(
  $$update public.credential_items
    set workspace_id='10000000-0000-4000-8000-000000000012'
    where id='10000000-0000-4000-8000-000000000050'$$,
  '55000', 'credential identity is immutable',
  'credential identity cannot cross workspaces'
);
select throws_ok(
  $$update public.credential_items set status='deleted',revoked_at=now(),
      deletion_requested_at=now(),deletion_verified_at=now()
    where id='10000000-0000-4000-8000-000000000050'$$,
  '55000', 'invalid credential lifecycle transition',
  'credential deletion cannot skip revocation and deletion-pending states'
);
select throws_ok(
  $$insert into public.credential_profile_bindings (
      credential_item_id,workspace_id,browser_profile_id,
      credential_configuration_version,status
    ) values (
      '10000000-0000-4000-8000-000000000050',
      '10000000-0000-4000-8000-000000000012',
      '10000000-0000-4000-8000-000000000020',repeat('c',64),'active'
    )$$,
  '23503', null,
  'credential profile bindings cannot cross workspaces'
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
  $$insert into public.credential_access_events (
      workspace_id,credential_item_id,executor,action_request_id,reason_code,result
    ) values (
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000050','system',
      '10000000-0000-4000-8000-000000000006','fixture_missing_run','requested'
    )$$,
  '23514', 'credential access action requires a run anchor',
  'credential access events require a run anchor for actions'
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

insert into public.action_requests (
  id, workspace_id, run_id, tool_name, risk, summary, input, input_hash,
  semantic_intent, semantic_intent_hash, guard_conditions,
  guard_conditions_hash, status, expires_at
) values (
  '10000000-0000-4000-8000-000000000041',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  'fixture.semantic', 'write', 'semantic fixture', '{}', repeat('9', 64),
  '{"version":1,"effect":"create","resource":{"class":"fixture"},"provider":"openinstinct","exactOrigin":null,"recipients":[],"reversibility":"reversible","commitPoint":true,"credentialUse":"none","postconditions":[]}',
  repeat('a', 64),
  '{"version":1,"payloadHash":"9999999999999999999999999999999999999999999999999999999999999999","exactOrigin":null,"accountId":null,"counterpartyId":null,"recipientIds":[],"amount":null,"connectionId":null,"connectionConfigVersion":null,"browserProfileId":null,"browserProfileConfigVersion":null,"observationHash":null}',
  repeat('b', 64), 'pending', now() + interval '1 hour'
);
select throws_ok(
  $$insert into public.approvals (
      workspace_id, action_request_id, approved, input_hash, channel,
      semantic_intent_hash, guard_conditions_hash
    ) values (
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000041', true, repeat('9', 64),
      'fixture', repeat('a', 64), repeat('c', 64)
    )$$,
  '23514', 'approval semantic binding mismatch',
  'altered semantic guards invalidate approval'
);
select throws_ok(
  $$insert into public.approvals (
      workspace_id, action_request_id, approved, input_hash, channel,
      semantic_intent_hash, guard_conditions_hash
    ) values (
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000041', true, repeat('9', 64),
      'fixture', null, repeat('b', 64)
    )$$,
  '23514', null,
  'approval semantic hash bundles cannot be partially null'
);
select lives_ok(
  $$insert into public.approvals (
      workspace_id, action_request_id, approved, input_hash, channel,
      semantic_intent_hash, guard_conditions_hash
    ) values (
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000041', true, repeat('9', 64),
      'fixture', repeat('a', 64), repeat('b', 64)
    )$$,
  'matching semantic intent and guards can be approved'
);
select throws_ok(
  $$update public.action_requests set semantic_intent = '{"changed":true}'
    where id = '10000000-0000-4000-8000-000000000041'$$,
  '55000', 'action authority snapshot is immutable',
  'semantic approval snapshots are immutable'
);
update public.action_requests set status = 'executed'
where id = '10000000-0000-4000-8000-000000000041';
select throws_ok(
  $$insert into public.action_requests (
      id, workspace_id, run_id, tool_name, risk, summary, input, input_hash,
      semantic_intent, semantic_intent_hash, guard_conditions,
      guard_conditions_hash, status, expires_at
    ) values (
      '10000000-0000-4000-8000-000000000046',
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000003',
      'fixture.semantic', 'write', 'partial semantic fixture', '{}', repeat('9', 64),
      '{"version":1}', null, '{"version":1}', repeat('b', 64),
      'pending', now() + interval '1 hour'
    )$$,
  '23514', null,
  'action semantic bundles cannot be partially null'
);

select throws_ok(
  $$insert into public.authority_grants (
      workspace_id,name,effects,resource_classes,providers,starts_at,expires_at,
      configuration_version
    ) values (
      '10000000-0000-4000-8000-000000000002','purchase grant',
      array['purchase'],array['order'],array['test'],now(),now()+interval '1 day',repeat('1',64)
    )$$,
  '23514', null,
  'phase three cannot grant financial authority'
);
select throws_ok(
  $$insert into public.authority_grants (
      workspace_id,name,effects,resource_classes,providers,starts_at,expires_at,
      configuration_version
    ) values (
      '10000000-0000-4000-8000-000000000002','unscoped send',
      array['send'],array['message'],array['test'],now(),now()+interval '1 day',repeat('2',64)
    )$$,
  '23514', null,
  'communication grants require exact recipient scope'
);
select lives_ok(
  $$insert into public.authority_grants (
      id,workspace_id,name,effects,resource_classes,providers,origins,
      max_uses,starts_at,expires_at,configuration_version
    ) values (
      '10000000-0000-4000-8000-000000000043',
      '10000000-0000-4000-8000-000000000002','bounded create',
      array['create'],array['fixture'],array['test'],array['https://example.test'],
      1,now(),now()+interval '1 day',repeat('3',64)
    )$$,
  'bounded reversible authority can be created'
);
select throws_ok(
  $$update public.authority_grants set name='mutated'
    where id='10000000-0000-4000-8000-000000000043'$$,
  '55000', 'authority grant versions are immutable',
  'grant scope is immutable after creation'
);
select throws_ok(
  $$insert into public.authority_grants (
      workspace_id,name,effects,resource_classes,providers,starts_at,expires_at,
      configuration_version
    ) values (
      '10000000-0000-4000-8000-000000000002','delete grant',
      array['delete'],array['fixture'],array['test'],now(),now()+interval '1 day',repeat('5',64)
    )$$,
  '23514', null,
  'destructive effects cannot be delegated by a grant'
);

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
insert into public.workflow_steps (
  id, workspace_id, run_id, action_request_id, position, kind, tool_name,
  status, execution_phase, input, input_hash, attempt, started_at, completed_at
) values (
  '10000000-0000-4000-8000-000000000042',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000041',
  10, 'action', 'fixture.semantic', 'succeeded', 'result_persisted', '{}',
  repeat('9', 64), 1, now(), now()
);
insert into public.action_evidence (
  id, workspace_id, run_id, action_request_id, workflow_step_id,
  phase, outcome, verifier, verifier_version, evidence_hash, captured_at
) values (
  '10000000-0000-4000-8000-000000000044',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000041',
  '10000000-0000-4000-8000-000000000042',
  'postcondition','observed','fixture.readback',1,repeat('4',64),now()
);
select throws_ok(
  $$insert into app_private.action_evidence_payloads (
      evidence_id, workspace_id, redacted_facts, payload_hash, redaction_version
    ) values (
      '10000000-0000-4000-8000-000000000044',
      '10000000-0000-4000-8000-000000000002', '{}', repeat('5',64), 1
    )$$,
  '23514', 'private evidence payload hash mismatch',
  'private evidence payload must bind to public evidence hash'
);
select lives_ok(
  $$insert into app_private.action_evidence_payloads (
      evidence_id, workspace_id, redacted_facts, payload_hash, redaction_version
    ) values (
      '10000000-0000-4000-8000-000000000044',
      '10000000-0000-4000-8000-000000000002', '{}', repeat('4',64), 1
    )$$,
  'matching private evidence payload is accepted'
);
select throws_ok(
  $$update app_private.action_evidence_payloads set redacted_facts='{"changed":true}'
    where evidence_id='10000000-0000-4000-8000-000000000044'$$,
  '55000', 'action_evidence_payloads is append-only',
  'private evidence payload rejects updates'
);
select throws_ok(
  $$delete from app_private.action_evidence_payloads
    where evidence_id='10000000-0000-4000-8000-000000000044'$$,
  '55000', 'action_evidence_payloads is append-only',
  'private evidence payload rejects deletes'
);
select throws_ok(
  $$update public.action_evidence set outcome='inconclusive'
    where id='10000000-0000-4000-8000-000000000044'$$,
  '55000', 'action_evidence is append-only',
  'action evidence rejects updates'
);
select throws_ok(
  $$delete from public.action_evidence
    where id='10000000-0000-4000-8000-000000000044'$$,
  '55000', 'action_evidence is append-only',
  'action evidence rejects deletes'
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
select throws_ok(
  $$insert into public.credential_access_events (
      workspace_id,credential_item_id,executor,browser_execution_id,
      reason_code,result
    ) values (
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000050','system',
      '10000000-0000-4000-8000-000000000030','fixture_missing_anchors','requested'
    )$$,
  '23514', 'credential access execution requires profile and run anchors',
  'credential access events require profile and run anchors for executions'
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
  2,
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

update public.credential_items set status='revoked',revoked_at=now()
where id='10000000-0000-4000-8000-000000000050';
select throws_ok(
  $$update public.credential_items set label='Rewritten history'
    where id='10000000-0000-4000-8000-000000000050'$$,
  '55000', 'revoked credential history is immutable',
  'revoked credential history rejects metadata changes'
);
update public.credential_items set status='deletion_pending',deletion_requested_at=now()
where id='10000000-0000-4000-8000-000000000050';
select throws_ok(
  $$update public.credential_items set status='deleted',deletion_verified_at=now()
    where id='10000000-0000-4000-8000-000000000050'$$,
  '55000', 'credential ciphertext deletion is unverified',
  'credential metadata cannot be deleted while ciphertext remains'
);
delete from app_private.credential_secrets
where credential_item_id='10000000-0000-4000-8000-000000000050';
update public.credential_items set status='deleted',deletion_verified_at=now()
where id='10000000-0000-4000-8000-000000000050';
select throws_ok(
  $$update public.credential_items set username_hint='restored@example.test'
    where id='10000000-0000-4000-8000-000000000050'$$,
  '55000', 'revoked credential history is immutable',
  'deleted credential history cannot restore a username hint'
);

update public.browser_executions set status='failed',completed_at=now(),
  last_error_code='fixture_profile_released'
where id='10000000-0000-4000-8000-000000000030';
update public.browser_profiles set status='revoked',revoked_at=now(),
  deletion_requested_at=now(),deletion_verified_at=now()
where id='10000000-0000-4000-8000-000000000020';
delete from public.browser_profiles
where id='10000000-0000-4000-8000-000000000020';
update public.browser_profiles set status='revoked',revoked_at=now(),
  deletion_requested_at=now(),deletion_verified_at=now()
where id='10000000-0000-4000-8000-000000000021';
delete from public.browser_profiles
where id='10000000-0000-4000-8000-000000000021';

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
select throws_ok(
  $$insert into public.reconciliation_cases (
      workspace_id,run_id,action_request_id,unknown_result_id,method
    ) values (
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000041',
      '10000000-0000-4000-8000-000000000018','postcondition_read'
    )$$,
  '23514', 'reconciliation case must reference the matching unknown result',
  'reconciliation cases cannot cross action lineage'
);
select throws_ok(
  $$insert into public.workflow_steps (
      workspace_id,run_id,position,kind,tool_name,status,input,input_hash
    ) values (
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000003',20,'reconciliation',
      'reconciliation.read','running','{"evidence":{"secret":"no"}}',repeat('1',64)
    )$$,
  '23514', null,
  'reconciliation workflow input cannot expose private evidence facts'
);
select throws_ok(
  $$insert into public.action_evidence (
      workspace_id,run_id,action_request_id,workflow_step_id,tool_result_id,
      phase,outcome,verifier,verifier_version,evidence_hash,captured_at
    ) values (
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000041',
      '10000000-0000-4000-8000-000000000042',
      '10000000-0000-4000-8000-000000000018',
      'postcondition','observed','fixture.readback',1,repeat('2',64),now()
    )$$,
  '23514', 'action evidence result lineage mismatch',
  'action evidence cannot attach a result from another action'
);
select lives_ok(
  $$insert into public.reconciliation_cases (
      id,workspace_id,run_id,action_request_id,unknown_result_id,method
    ) values (
      '10000000-0000-4000-8000-000000000045',
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000006',
      '10000000-0000-4000-8000-000000000018','postcondition_read'
    )$$,
  'a matching unknown result can create one reconciliation case'
);
select throws_ok(
  $$update public.reconciliation_cases
    set action_request_id='10000000-0000-4000-8000-000000000041'
    where id='10000000-0000-4000-8000-000000000045'$$,
  '55000', 'reconciliation identity is immutable',
  'reconciliation cases cannot be repointed'
);
select throws_ok(
  $$delete from public.reconciliation_cases
    where id='10000000-0000-4000-8000-000000000045'$$,
  '55000', 'reconciliation cases are durable execution history',
  'reconciliation cases reject ordinary deletion'
);
select throws_ok(
  $$update public.reconciliation_cases set status='reconciled_succeeded'
    where id='10000000-0000-4000-8000-000000000045'$$,
  '55000', 'invalid reconciliation transition',
  'reconciliation cases reject illegal terminal jumps'
);
select lives_ok(
  $$update public.reconciliation_cases set status='running',attempt=1
    where id='10000000-0000-4000-8000-000000000045'$$,
  'a pending reconciliation case can be claimed'
);
insert into app_private.reconciliation_claims (
  case_id,workspace_id,lease_epoch,claim_token_hash,lease_expires_at
) values (
  '10000000-0000-4000-8000-000000000045',
  '10000000-0000-4000-8000-000000000002',1,repeat('3',64),now()-interval '1 second'
);
select lives_ok(
  $$update public.reconciliation_cases set status='running',attempt=2
    where id='10000000-0000-4000-8000-000000000045'$$,
  'an expired reconciliation claimant can be fenced and reclaimed'
);
insert into public.workflow_steps (
  id, workspace_id, run_id, position, kind, tool_name, status,
  execution_phase, input, input_hash, attempt, started_at, completed_at
) values (
  '10000000-0000-4000-8000-000000000019',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  1, 'reconciliation', 'reconciliation.read', 'succeeded',
  'result_persisted',
  '{"caseId":"10000000-0000-4000-8000-000000000045","unknownResultId":"10000000-0000-4000-8000-000000000018","evidenceHash":"6666666666666666666666666666666666666666666666666666666666666666","safeSummary":"Fixture reconciliation observation."}',
  repeat('6', 64), 1, now(), now()
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
