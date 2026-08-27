# OpenInstinct

OpenInstinct is an open-source, single-owner personal assistant that lives in iMessage. It receives and sends messages through the GA Blooio v4 API, reads Gmail and Google Calendar through direct OAuth, connects to remote MCP servers, and can use a cloud browser. External writes are durable, inspectable, and approval-gated.

There is no new chat interface. The web app is a small owner-only control plane for setup, connectors, audit history, and approvals.

## What works

- Blooio v4 webhook verification, deduplication, iMessage replies, and idempotent sends
- Durable agent runs and retries with Supabase Postgres and `pgmq`
- Direct Google OAuth with PKCE, encrypted refresh tokens, Gmail reads/drafts, and Calendar reads/writes
- Generic HTTPS MCP registration and tool discovery; MCP calls require explicit approval
- Hash-bound approval requests so approved inputs cannot be changed before execution
- Kernel browser provider abstraction, with sessions and persistent profiles
- Vercel deployment with a cron-driven consumer, or a continuously running Docker worker
- CLI-friendly setup, diagnostics, webhook registration, and smoke checks

## Fastest setup

Prerequisites: Node 22+, pnpm 10, a Supabase project, a Blooio account/number, and a Vercel account. The default profile works on Vercel Hobby by using a free Cloudflare Cron Trigger for queue consumption. Google OAuth and Kernel are optional until you connect those features.

```bash
git clone <your-fork-url> openinstinct
cd openinstinct
corepack enable
pnpm install
pnpm run setup -- --target vercel
```

`pnpm run setup` creates `.env.local`, generates the two local cryptographic secrets, and prints every missing prerequisite. It never prints generated secrets. Fill the remaining values, then:

```bash
supabase login
supabase link --project-ref <project-ref>
supabase db push
vercel link
pnpm run doctor -- --target vercel
vercel deploy --prod
pnpm run openinstinct -- create-blooio-webhook \
  --url https://your-domain.example --env-file .env.local
pnpm run smoke -- --url https://your-domain.example
```

Deploy the free one-minute scheduler after `INTERNAL_API_SECRET` and `NEXT_PUBLIC_APP_URL` are set in `.env.local`:

```bash
sed -n 's/^NEXT_PUBLIC_APP_URL=//p' .env.local | \
  pnpm --dir infra/cloudflare-scheduler exec wrangler secret put CONSUMER_URL
sed -n 's/^INTERNAL_API_SECRET=//p' .env.local | \
  pnpm --dir infra/cloudflare-scheduler exec wrangler secret put INTERNAL_API_SECRET
pnpm --dir infra/cloudflare-scheduler deploy
```

After creating the Blooio webhook, push the newly captured `BLOOIO_WEBHOOK_SECRET` to your deployment without displaying it:

```bash
sed -n 's/^BLOOIO_WEBHOOK_SECRET=//p' .env.local | \
  vercel env add BLOOIO_WEBHOOK_SECRET production --force
```

The secret flows over stdin and is not printed or placed in shell history. Use the equivalent secret-manager CLI for other hosts. Redeploy after changing production environment variables.

Open the deployed URL, request the owner magic link using `OWNER_EMAIL`, and onboard with the exact E.164 phone number in `BLOOIO_OWNER_PHONE`. The database enforces one owner workspace per deployment.

## Environment

Copy [`.env.example`](./.env.example). Required production variables are:

| Variable                               | Purpose                                               |
| -------------------------------------- | ----------------------------------------------------- |
| `NEXT_PUBLIC_APP_URL`                  | Canonical HTTPS control-plane URL                     |
| `NEXT_PUBLIC_SUPABASE_URL`             | Supabase project URL                                  |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Browser-safe publishable key                          |
| `SUPABASE_SECRET_KEY`                  | Server-only Supabase secret key                       |
| `DATABASE_URL`                         | Direct or pooler Postgres URL; use SSL remotely       |
| `SECRET_ENCRYPTION_KEY`                | Base64 32-byte AES key for connector credentials      |
| `BLOOIO_API_KEY`                       | Blooio v4 API key                                     |
| `BLOOIO_WEBHOOK_SECRET`                | One-time secret returned when the webhook is created  |
| `BLOOIO_OWNER_PHONE`                   | The sole owner’s E.164 phone number                   |
| `OWNER_EMAIL`                          | The only email allowed to sign in and claim ownership |
| `AI_MODEL`                             | AI SDK model id; defaults to `openai/gpt-5.6-sol`     |
| `AI_GATEWAY_API_KEY`                   | Vercel AI Gateway key                                 |
| `INTERNAL_API_SECRET`                  | Protects non-Vercel queue-consumer calls              |

For Google, set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and the exact `GOOGLE_REDIRECT_URI`. Add that URI to the Google OAuth client. `KERNEL_API_KEY` enables the optional browser runtime. On Vercel, set `CRON_SECRET`; Vercel sends it to cron routes automatically.

## Local development

Docker is required for the local Supabase stack.

```bash
pnpm supabase:start
pnpm supabase:reset
pnpm dev
```

Use the local Supabase output to fill the URL, publishable key, secret key, and database URL in `.env.local`. Local auth email appears in Supabase Inbucket at `http://127.0.0.1:54324`.

Run all checks:

```bash
pnpm check
pnpm build
pnpm supabase:test
```

## Deployment choices

- **Vercel Hobby + Cloudflare Scheduler:** recommended free compute profile. Vercel hosts the web app and the included Cloudflare Worker securely invokes a small queue batch every minute.
- **Vercel Pro + native cron:** remove the external scheduler and add the one-minute `/api/internal/consume` cron to `vercel.json` if you prefer a single provider.
- **Google Cloud Run + Cloud Scheduler:** no Vercel account required. Both services have free allowances suitable for light personal usage, although Google requires a billing account.
- **Vercel + worker container:** lower latency. Deploy the `worker` Docker target to Cloud Run, ECS/Fargate, or any container host.
- **Docker Compose:** self-host both services using [`compose.yaml`](./compose.yaml).
- **Cloudflare:** use it as an ingress/control-plane alternative only with an external Node worker and Postgres connection strategy; the shipped primary web artifact targets Next.js Node runtime.

See [deployment details](./docs/deployment/README.md) and [architecture](./docs/architecture.md).

## Agent-first repository contract

Point Codex or another coding agent at the repository root and tell it to read [`AGENTS.md`](./AGENTS.md). That file immediately routes it to the canonical [`agent overview`](./docs/agent-overview.md), which explains the runtime, safety invariants, state model, repository map, and recipes for adding connectors, actions, channels, browser tools, and database features. Then run:

```bash
pnpm install
pnpm run setup -- --target <vercel|aws|gcp|docker>
pnpm run doctor -- --target <target> --json
```

Commands use stable exit codes: `0` success, `2` missing setup, `3` failed smoke check. `--json` emits machine-readable results. Cloud provisioning remains explicit because it can create billable resources; all routine setup after authorization is CLI-controlled.

Vercel Hobby is intended for personal, non-commercial deployments. For commercial deployments that must remain independent of Vercel, use the Cloud Run or self-hosted Docker profile.

## Trust model

Read-only Google calls may execute automatically. Gmail drafts, Calendar writes, and every generic MCP call are persisted first and require owner approval. Security-setting changes are denied. Approval records bind to the SHA-256 hash of canonical tool input plus the exact connector account/configuration version, and execution rechecks provider/tool allowlists. Ambiguous provider outcomes are marked `unknown` and never retried automatically.

This is personal automation software with access to sensitive data. Review [`SECURITY.md`](./SECURITY.md) before exposing it publicly.

## License

MIT
