begin;
select plan(9);

select has_table('public', 'workspaces', 'workspaces table exists');
select has_table('public', 'action_requests', 'action requests table exists');
select has_table('pgmq', 'q_agent_jobs', 'durable agent queue exists');
select ok((select relrowsecurity from pg_class where oid = 'public.connections'::regclass), 'connections use RLS');
select ok((select count(*) > 0 from pg_policies where schemaname = 'public' and tablename = 'connections'), 'connections have owner policies');
select ok((select count(*) = 1 from pg_indexes where schemaname = 'public' and indexname = 'workspaces_single_owner_deployment_idx'), 'deployment enforces one owner workspace');
select ok(not has_table_privilege('authenticated', 'public.workspaces', 'INSERT'), 'clients cannot claim workspaces directly');
select ok(not has_table_privilege('authenticated', 'public.connections', 'UPDATE'), 'clients cannot mutate connector security state');
select has_view('public', 'connection_summaries', 'safe connector summaries view exists');

select * from finish();
rollback;
