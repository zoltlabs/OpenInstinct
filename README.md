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

Costs below are rough monthly USD estimates for one lightly used personal deployment, checked August 2026. “Platform” covers the web app, scheduler/worker, and Supabase; “fixed total” also includes the current $39/month Blooio Starter plan. Model tokens, optional browser usage, domains, taxes, and usage overages are separate.

| Path                                                    |                 Estimated platform |                     Estimated fixed total | Best for                                                                                                                               |
| ------------------------------------------------------- | ---------------------------------: | ----------------------------------------: | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Vercel Hobby + Cloudflare Scheduler + Supabase Free** |                       **$0/month** |                       **about $39/month** | Trying the full product as a personal project. Supabase may pause after one inactive week and has no automatic backups.                |
| **Vercel Hobby + Cloudflare Scheduler + Supabase Pro**  |                **about $25/month** |                       **about $64/month** | **Recommended for a reliable personal assistant.** The database does not pause and includes daily backups, while compute remains free. |
| **Vercel Pro native cron + Supabase Pro**               |                **about $45/month** |                       **about $84/month** | A single web/scheduler provider and one-minute native cron without the Cloudflare Worker.                                              |
| **Cloud Run + Cloud Scheduler + Supabase Pro**          |             **about $25–30/month** |                    **about $64–69/month** | Recommended no-Vercel path. Light scale-to-zero usage generally fits Google's free allowances, but a billing account is required.      |
| **Docker Compose + hosted Supabase**                    | **$0 or $25/month, plus the host** | **about $39 or $64/month, plus the host** | Existing hardware, a home server, or a VPS. Use Supabase Pro when database pausing is unacceptable.                                    |

The recommended progression is:

1. Start with **Vercel Hobby + Cloudflare Scheduler + Supabase Free** to validate Blooio, OAuth, and the agent flow without paying for compute.
2. Upgrade only Supabase to Pro when this becomes a real everyday assistant. This is the best reliability-to-cost tradeoff for most personal deployments.
3. Use **Cloud Run + Cloud Scheduler** when you want no Vercel dependency, or **Vercel Pro native cron** when reducing the number of providers matters more than the extra $20/month.
4. Add a continuously running worker only when one-minute polling latency is too slow. A small Cloud Run or ECS/Fargate worker commonly adds roughly $10–50+/month depending on whether it can scale down, its region, and allocated CPU/memory.

[Vercel Hobby is limited to personal, non-commercial use](https://vercel.com/docs/plans/hobby). For commercial use, choose Vercel Pro or another host and use the applicable Blooio commercial plan; the table's fixed totals use the personal Starter price.

Current price references: [Supabase](https://supabase.com/pricing), [Vercel](https://vercel.com/pricing), [Cloudflare Workers](https://developers.cloudflare.com/workers/platform/pricing/), [Cloud Run](https://cloud.google.com/run/pricing), [Cloud Scheduler](https://cloud.google.com/scheduler/pricing), and [Blooio](https://blooio.com/pricing).

AI and browser use are variable rather than fixed hosting costs. Vercel AI Gateway currently includes $5/month on its free tier and otherwise passes through model prices without markup; a reasonable initial budget alert for light personal use is $5–30/month, then adjust from observed usage. Kernel currently has a free developer tier with $5 in usage credits; its Hobbyist tier is $30/month plus usage. See [AI Gateway pricing](https://vercel.com/docs/ai-gateway/pricing) and [Kernel pricing](https://www.kernel.sh/pricing).

Cloudflare can also replace the web ingress, but it is a secondary architecture rather than a shipped deployment target: keep an external Node worker and a suitable Postgres connection strategy. The primary web artifact targets the Next.js Node runtime.

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
