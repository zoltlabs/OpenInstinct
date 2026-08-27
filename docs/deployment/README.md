# Deployment profiles

All profiles use hosted Supabase for Auth, Postgres, `pgmq`, and migrations. Run `supabase db push` before deploying application code. Set `OWNER_EMAIL` before exposing the deployment; only that normalized address can request the owner magic link or complete the server-side ownership transaction.

## Vercel

Link the repository root with `vercel link`, add every production variable from `.env.example`, and deploy with `vercel deploy --prod`. [`vercel.json`](../../vercel.json) builds the web workspace and invokes `/api/internal/consume` every minute. Set `CRON_SECRET` in Vercel so cron requests are authenticated. Per-minute cron requires Vercel Pro or Enterprise; Hobby rejects this schedule at deployment, so use the external worker profile on Hobby.

For faster replies, deploy the worker container as well and disable the Vercel cron after confirming the external worker is healthy. Multiple consumers are queue-safe, but one operating mode is easier to observe.

## Docker

```bash
docker compose up --build -d
pnpm smoke -- --url http://localhost:3000 --worker-url http://localhost:3001
```

The image has `web` and `worker` targets. Keep `.env.local` mode `0600`; Compose injects it and the Docker build excludes it.

## Google Cloud Run

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
