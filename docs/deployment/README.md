# Deployment profiles

All profiles use hosted Supabase for Auth, Postgres, `pgmq`, and migrations. Local Supabase is an optional database-development tool, not a production setup prerequisite. Run `pnpm exec supabase db push --linked` before deploying application code. Configure the hosted Auth Site URL and exact `/api/auth/callback` redirect for the application URL. Set `OWNER_EMAIL` before exposing the deployment; only that normalized address can request the owner magic link or complete the server-side ownership transaction.

For agent-operated provisioning, prefer an authorized Supabase MCP/API integration. Use browser control only as fallback, and pause before project creation or credential generation. After creation, `openinstinct configure-supabase` captures the database URL through hidden input and writes project keys without printing them.

## Vercel Hobby + Cloudflare Scheduler (free default)

Link the repository root with `vercel link`, run `pnpm run openinstinct -- push-vercel-env --environment production`, and deploy with `vercel deploy --prod`. The sync command sends allowlisted `.env.local` values over stdin and suppresses provider output. [`vercel.json`](../../vercel.json) intentionally contains no native cron, so it deploys on Hobby. The included [`cloudflare-scheduler`](../../infra/cloudflare-scheduler/wrangler.jsonc) calls the protected consumer once per minute. Store `CONSUMER_URL` and the same `INTERNAL_API_SECRET` using `wrangler secret put`, then run `pnpm --dir infra/cloudflare-scheduler deploy`.

This scheduler performs one outbound fetch and no agent work itself. The Next.js function claims and processes the durable Supabase queue. It can therefore use Cloudflare's free Cron Trigger while the application remains on Vercel Hobby.

## Vercel Pro native cron

If you prefer a single provider, add `{ "path": "/api/internal/consume", "schedule": "* * * * *" }` to the `crons` array in `vercel.json` and set `CRON_SECRET`. Vercel Hobby rejects schedules more frequent than daily; native one-minute cron requires Pro or Enterprise.

For faster replies, deploy the worker container as well and disable the Vercel cron after confirming the external worker is healthy. Multiple consumers are queue-safe, but one operating mode is easier to observe.

## Docker

```bash
docker compose up --build -d
pnpm run smoke -- --url http://localhost:3000 --worker-url http://localhost:3001
```

The image has `web` and `worker` targets. By default they connect to hosted Supabase. Keep `.env.local` mode `0600`; Compose injects it and the Docker build excludes it. Use `pnpm supabase:start` only when intentionally testing against a local database.

## Google Cloud Run

Cloud Run can host both the Next.js `web` container and the continuously running `worker` container, so this profile does not require Vercel. For the lowest idle cost, run the web container with request-based billing and scale-to-zero, then use one Cloud Scheduler job to POST the protected consumer endpoint every minute. Google provides a Cloud Run free allowance and three free Cloud Scheduler jobs per billing account, but a billing account is still required.

```bash
gcloud builds submit --tag REGION-docker.pkg.dev/PROJECT/REPOSITORY/openinstinct-worker
gcloud run deploy openinstinct-worker \
  --image REGION-docker.pkg.dev/PROJECT/REPOSITORY/openinstinct-worker \
  --region REGION --no-allow-unauthenticated
```

Build specifically from the `worker` target in CI or Cloud Build, inject secrets from Secret Manager, and configure a health check at `/health`. The service must retain at least one warm instance if you want continuous consumption. Alternatively, Cloud Scheduler can POST `/internal/consume` with the internal bearer secret.

## AWS ECS/Fargate

Build the `worker` target, push it to ECR, and run one Fargate task behind no public load balancer. Inject secrets from Secrets Manager and expose `/health` only to the load balancer or VPC health checker. Run the Next.js `web` target in a second service, or leave the control plane on Vercel.

## Cloudflare

Cloudflare is a secondary ingress option, not the default artifact in this repository. The worker depends on Node-compatible AI/MCP/Postgres clients and durable execution beyond a typical request. If using Cloudflare for the Next.js control plane, build with OpenNext, use `nodejs_compat`, route Postgres through Hyperdrive or an HTTPS data layer, and keep the supplied worker on Cloud Run/ECS. Validate Blooio raw-body signature handling after any proxy transformation.

## Rollback

Application rollback is provider-native (`vercel rollback`, a previous Cloud Run revision, or an ECS task definition). Database migrations are forward-only by default. Take a Supabase backup before destructive schema changes and ship additive migrations ahead of code that requires them.
