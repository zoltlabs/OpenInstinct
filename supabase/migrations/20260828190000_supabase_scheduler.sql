create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;

create or replace function app_private.invoke_consumer()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  consumer_url text;
  api_secret text;
  request_id bigint;
begin
  select decrypted_secret into consumer_url
  from vault.decrypted_secrets
  where name = 'openinstinct_consumer_url';

  select decrypted_secret into api_secret
  from vault.decrypted_secrets
  where name = 'openinstinct_internal_api_secret';

  if consumer_url is null or api_secret is null then
    raise exception 'OpenInstinct scheduler secrets are not configured';
  end if;

  select net.http_post(
    url := consumer_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || api_secret,
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  ) into request_id;

  return request_id;
end;
$$;

create or replace function app_private.configure_consumer_scheduler(
  consumer_url text,
  api_secret text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  url_secret_id uuid;
  api_secret_id uuid;
  existing_job_id bigint;
  scheduled_job_id bigint;
begin
  if consumer_url !~ '^https://[^[:space:]]+/api/internal/consume$' then
    raise exception 'Consumer URL must be a public HTTPS /api/internal/consume endpoint';
  end if;
  if length(api_secret) < 32 then
    raise exception 'Internal API secret must contain at least 32 characters';
  end if;

  select id into url_secret_id
  from vault.secrets
  where name = 'openinstinct_consumer_url';
  if url_secret_id is null then
    perform vault.create_secret(
      consumer_url,
      'openinstinct_consumer_url',
      'OpenInstinct protected queue consumer endpoint'
    );
  else
    perform vault.update_secret(url_secret_id, consumer_url);
  end if;

  select id into api_secret_id
  from vault.secrets
  where name = 'openinstinct_internal_api_secret';
  if api_secret_id is null then
    perform vault.create_secret(
      api_secret,
      'openinstinct_internal_api_secret',
      'Bearer secret for the OpenInstinct queue consumer'
    );
  else
    perform vault.update_secret(api_secret_id, api_secret);
  end if;

  select jobid into existing_job_id
  from cron.job
  where jobname = 'openinstinct-consumer';
  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;

  select cron.schedule(
    'openinstinct-consumer',
    '* * * * *',
    'select app_private.invoke_consumer()'
  ) into scheduled_job_id;
  return scheduled_job_id;
end;
$$;

revoke all on function app_private.invoke_consumer() from public, anon, authenticated;
revoke all on function app_private.configure_consumer_scheduler(text, text) from public, anon, authenticated;
grant execute on function app_private.invoke_consumer() to postgres;
grant execute on function app_private.configure_consumer_scheduler(text, text) to postgres;
