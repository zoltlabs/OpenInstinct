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
- Direct OpenAI, Anthropic, and Google model access, plus optional OpenRouter, Vercel AI Gateway, and OpenAI-compatible providers
- Vercel deployment with a cron-driven consumer, or a continuously running Docker worker
- CLI-friendly setup, diagnostics, webhook registration, and smoke checks

## Fastest setup

The easiest path is agent-operated. Connect authorized Supabase and Vercel integrations to Codex or another capable coding agent, open this repository, and ask:

> Set up OpenInstinct using my connected Supabase and Vercel accounts. Follow AGENTS.md and docs/agent-setup.md, and pause before creating projects, storing credentials, or deploying publicly.

The owner needs Node 22+, pnpm 10, and Supabase and Vercel accounts. The agent handles local preparation, database linking and migrations, deployment, final URL wiring, Supabase Auth, environment synchronization, the scheduler, and verification. It asks only at the explicit confirmation or private credential boundaries.

Google Cloud and `gcloud` are optional and only needed for Gmail and Calendar. Blooio and Kernel are also post-deploy integrations. None of them blocks the core deployment.

Start with:

```bash
git clone <your-fork-url> openinstinct
cd openinstinct
corepack enable
pnpm install
pnpm run setup -- --target vercel --database hosted --json
```

`setup` creates `.env.local`, generates local cryptographic secrets, and returns the ordered action plan. Expected missing provider configuration is reported as `ready: false`; it does not make the setup command fail. The agent should parse `checks` and `actions` and continue from there.

When private input is needed, run `pnpm run openinstinct -- setup-ui`. The loopback-only wizard never renders an existing secret, preserves blank fields, rejects cross-origin submissions, and writes `.env.local` with mode `0600`. New Vercel setups default to Vercel AI Gateway, so no separate model-provider key is required.

The agent uses the connected Supabase integration to create or select the database project, then privately captures its Postgres connection URL and applies the migrations. If no provider integration is available, the Supabase CLI or browser is the fallback. Never pass a database password in command arguments.

After the project exists, enter its pooler or direct Postgres connection URL in the loopback setup page. The command below reads it from `.env.local`, links the project, retrieves its API keys without printing them, and writes all Supabase connection values with mode `0600`:

```bash
pnpm exec supabase login
pnpm run openinstinct -- configure-supabase --project-ref <project-ref> --use-env-database-url
pnpm exec supabase db push --linked
```

Creating the Vercel project assigns its default production domain. The agent reads that domain before deployment, stores it locally, configures Supabase Auth, synchronizes the environment, and deploys once:

```bash
vercel link
pnpm run openinstinct -- set-app-url --url https://your-production-url.example
# Through the Supabase integration:
#   Site URL = NEXT_PUBLIC_APP_URL
#   Allowed redirect = NEXT_PUBLIC_APP_URL/api/auth/callback
pnpm run doctor -- --target vercel --phase bootstrap --json
pnpm run openinstinct -- push-vercel-env --environment production
vercel deploy --prod
pnpm run openinstinct -- configure-supabase-scheduler --json
```

That is the complete core deployment. Optional iMessage onboarding happens afterward:

```bash
pnpm run openinstinct -- create-blooio-webhook \
  --url https://your-domain.example --env-file .env.local
pnpm run openinstinct -- push-vercel-env --environment production
vercel deploy --prod
```

`bootstrap` can tolerate a temporary localhost URL during recovery, but the normal MCP-first path knows the Vercel production domain before deployment. It does not require Blooio. `ready` requires a final public HTTPS URL and the complete iMessage configuration. The webhook command stores its one-time signing secret without displaying it.

The scheduler command stores the protected consumer URL and `INTERNAL_API_SECRET` in Supabase Vault, then creates an idempotent one-minute Supabase Cron job. No secret is printed or embedded in the cron command. After post-deploy integrations are ready, verify the deployment:

```bash
pnpm run doctor -- --target vercel --phase ready --json
pnpm run smoke -- --url https://your-domain.example --json
```

Every allowlisted value flows over stdin and is not printed or placed in shell history. Use the equivalent secret-manager CLI for other hosts. Redeploy after changing production environment variables.

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
| `AI_PROVIDER`                          | Direct or optional routing provider                   |
| `AI_MODEL`                             | Provider-native model id                              |
| Selected provider credential           | The matching server-only API key described below      |
| `INTERNAL_API_SECRET`                  | Protects non-Vercel queue-consumer calls              |

Model providers are selected explicitly:

| `AI_PROVIDER`       | Required configuration                                                          | `AI_MODEL` form                         |
| ------------------- | ------------------------------------------------------------------------------- | --------------------------------------- |
| `openai`            | `OPENAI_API_KEY`                                                                | Native OpenAI id, such as `gpt-5.6-sol` |
| `anthropic`         | `ANTHROPIC_API_KEY`                                                             | Native Anthropic id                     |
| `google`            | `GOOGLE_GENERATIVE_AI_API_KEY`                                                  | Native Gemini id                        |
| `openrouter`        | `OPENROUTER_API_KEY`                                                            | OpenRouter's namespaced model id        |
| `vercel-gateway`    | `AI_GATEWAY_API_KEY`, or Vercel OIDC when deployed there                        | Gateway's namespaced model id           |
| `openai-compatible` | `AI_COMPATIBLE_BASE_URL`; `AI_COMPATIBLE_API_KEY` when the endpoint requires it | The endpoint's model id                 |

Direct OpenAI, Anthropic, or Google access is the normal path; no AI gateway is required. For optional failover, set both `AI_FALLBACK_PROVIDER` and `AI_FALLBACK_MODEL` plus that provider's credential. The fallback runs only when a model generation fails, before the resulting tool call can execute. OpenRouter is the recommended host-neutral fallback; Vercel AI Gateway is convenient when the deployment already runs on Vercel.

Existing Gateway deployments can preserve their current behavior by setting `AI_PROVIDER=vercel-gateway` and keeping the existing namespaced `AI_MODEL`. To migrate to direct OpenAI, set `AI_PROVIDER=openai`, remove the `openai/` prefix from `AI_MODEL`, and provide `OPENAI_API_KEY`.

For Google application access, separately set all three of `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and the exact `GOOGLE_REDIRECT_URI`, or leave all three unset. Those OAuth credentials are unrelated to `GOOGLE_GENERATIVE_AI_API_KEY`. Add the redirect URI to the Google OAuth client; the [Google setup runbook](./docs/google-setup.md) covers the agent-operated `gcloud` and browser flow. `KERNEL_API_KEY` enables the optional browser runtime. For the Vercel Pro cron profile, set `CRON_SECRET`; Vercel sends it to cron routes automatically.

## Optional local database development

The normal setup path uses hosted Supabase. Run a local Supabase stack only when developing migrations, RLS, or database behavior; Docker is required for this optional profile.

```bash
pnpm run setup -- --target docker --database local
pnpm supabase:start
pnpm supabase:reset
pnpm dev
```

Use the local Supabase output to fill the URL, publishable key, secret key, and database URL in the root `.env.local`. `pnpm dev` explicitly loads that file for both the web app and worker. Local auth email appears in Supabase Inbucket at `http://127.0.0.1:54324`; both `localhost` and `127.0.0.1` callback URLs are allowlisted.

Run all checks:

```bash
pnpm check
pnpm build
pnpm supabase:test
```

## Deployment choices

Costs below are rough monthly USD estimates for one lightly used personal deployment, checked August 2026. “Platform” covers the web app, scheduler/worker, and Supabase; “fixed total” also includes the current $39/month Blooio Starter plan. Model tokens, optional browser usage, domains, taxes, and usage overages are separate.

| Path                                             |                 Estimated platform |                     Estimated fixed total | Best for                                                                                                                          |
| ------------------------------------------------ | ---------------------------------: | ----------------------------------------: | --------------------------------------------------------------------------------------------------------------------------------- |
| **Vercel Hobby + Supabase Cron + Supabase Free** |                       **$0/month** |                       **about $39/month** | **Recommended starting path.** Two infrastructure accounts, with scheduling kept inside the existing database.                    |
| **Vercel Hobby + Supabase Cron + Supabase Pro**  |                **about $25/month** |                       **about $64/month** | Optional reliability upgrade for automatic database backups, more storage, and support.                                           |
| **Vercel Pro native cron + Supabase Pro**        |                **about $45/month** |                       **about $84/month** | A single web/scheduler provider and one-minute native cron without the Cloudflare Worker.                                         |
| **Cloud Run + Cloud Scheduler + Supabase Pro**   |             **about $25–30/month** |                    **about $64–69/month** | Recommended no-Vercel path. Light scale-to-zero usage generally fits Google's free allowances, but a billing account is required. |
| **Docker Compose + hosted Supabase**             | **$0 or $25/month, plus the host** | **about $39 or $64/month, plus the host** | Existing hardware, a home server, or a VPS. Use Supabase Pro when database pausing is unacceptable.                               |

The recommended progression is:

1. Start with **Vercel Hobby + Supabase Cron + Supabase Free**. Add Blooio only when the deployed control plane is ready for iMessage onboarding.
2. Upgrade only Supabase to Pro if you specifically need automatic backups, additional database capacity, or paid support.
3. Use **Cloud Run + Cloud Scheduler** when you want no Vercel dependency, or **Vercel Pro native cron** when you want scheduling on Vercel. The legacy Cloudflare scheduler remains available as the `vercel-cloudflare` advanced profile.
4. Add a continuously running worker only when one-minute polling latency is too slow. A small Cloud Run or ECS/Fargate worker commonly adds roughly $10–50+/month depending on whether it can scale down, its region, and allocated CPU/memory.

[Vercel Hobby is limited to personal, non-commercial use](https://vercel.com/docs/plans/hobby). For commercial use, choose Vercel Pro or another host and use the applicable Blooio commercial plan; the table's fixed totals use the personal Starter price.

Current price references: [Supabase](https://supabase.com/pricing), [Vercel](https://vercel.com/pricing), [Cloudflare Workers](https://developers.cloudflare.com/workers/platform/pricing/), [Cloud Run](https://cloud.google.com/run/pricing), [Cloud Scheduler](https://cloud.google.com/scheduler/pricing), and [Blooio](https://blooio.com/pricing).

AI and browser use are variable rather than fixed hosting costs. Direct model APIs charge their normal token rates. OpenRouter and Vercel AI Gateway are optional routing/fallback choices, not required subscriptions; a reasonable initial budget alert for light personal use is $5–30/month, then adjust from observed usage. Kernel currently has a free developer tier with $5 in usage credits; its Hobbyist tier is $30/month plus usage. See [OpenRouter pricing](https://openrouter.ai/pricing), [AI Gateway pricing](https://vercel.com/docs/ai-gateway/pricing), and [Kernel pricing](https://www.kernel.sh/pricing).

Cloudflare can also replace the web ingress, but it is a secondary architecture rather than a shipped deployment target: keep an external Node worker and a suitable Postgres connection strategy. The primary web artifact targets the Next.js Node runtime.

See [deployment details](./docs/deployment/README.md) and [architecture](./docs/architecture.md).

For a Codex-driven installation, use the [agent-operated setup runbook](./docs/agent-setup.md).

## Agent-first repository contract

Point Codex or another coding agent at the repository root and tell it to read [`AGENTS.md`](./AGENTS.md). That file immediately routes it to the canonical [`agent overview`](./docs/agent-overview.md), which explains the runtime, safety invariants, state model, repository map, and recipes for adding connectors, actions, channels, browser tools, and database features. Then run:

```bash
pnpm install
pnpm run setup -- --target <vercel|vercel-pro|vercel-cloudflare|aws|gcp|docker> --database hosted --json
pnpm run doctor -- --target <target> --phase bootstrap --json
```

Commands use stable exit codes: `0` success, `2` missing setup, `3` failed smoke check. `--json` emits machine-readable checks and external-action metadata. Agents should prefer purpose-built MCP/API integrations, then CLIs, then browser control. They must pause at project creation, credential generation, paid-plan selection, and other consequential provider actions. Secrets enter through hidden prompts, stdin, OAuth, or provider secret stores and are never included in an agent prompt or command arguments.

Vercel Hobby is intended for personal, non-commercial deployments. For commercial deployments that must remain independent of Vercel, use the Cloud Run or self-hosted Docker profile.

## Trust model

Read-only Google calls may execute automatically. Gmail drafts, Calendar writes, and every generic MCP call are persisted first and require owner approval. Security-setting changes are denied. Approval records bind to the SHA-256 hash of canonical tool input plus the exact connector account/configuration version, and execution rechecks provider/tool allowlists. Ambiguous provider outcomes are marked `unknown` and never retried automatically.

This is personal automation software with access to sensitive data. Review [`SECURITY.md`](./SECURITY.md) before exposing it publicly.

## License

MIT
