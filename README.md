# OpenInstinct

OpenInstinct is an open-source, single-owner personal assistant that lives in iMessage. It receives and sends messages through the GA Blooio v4 API, reads Gmail and Google Calendar through direct OAuth, connects to remote MCP servers, and can use a cloud browser. External writes are durable, inspectable, and approval-gated.

There is no new chat interface. The web app is a small owner-only control plane for setup, connectors, audit history, and approvals.

> **Project status: alpha.** The safety architecture, clean setup, unit tests, production build, and database policy tests are automated. Treat the first deployment as a personal evaluation and report reproducible issues without including private data.

The recommended Vercel + Supabase infrastructure can start on free tiers. Using OpenInstinct through iMessage currently requires a Blooio plan after its trial (about **$39/month** for the referenced personal Starter plan), plus model usage and any optional browser usage. You can try a model-only local preview before creating Supabase, Vercel, or Blooio resources.

## What works

- Blooio v4 webhook verification, deduplication, iMessage replies, and idempotent sends
- Durable agent runs and retries with Supabase Postgres and `pgmq`
- Direct Google OAuth with PKCE, encrypted refresh tokens, Gmail reads/drafts, and Calendar reads/writes
- Conversational MCP resolution, one-click connector cards, per-owner browser OAuth,
  and bounded tool discovery; generic invocation remains disabled until a reviewed semantic adapter exists
- Public HTTPS web fetches with redirect, response-size, and private-network protections
- Owner-approved durable memory with explicit destructive forgetting
- One-time and recurring reminders plus scheduled agent routines on the durable queue
- Hash-bound approval requests so approved inputs cannot be changed before execution
- Kernel adaptive read-only public-page research and short-lived owner takeover; browser writes and unattended authenticated-profile research fail closed
- An internal website-credential vault with exact-origin, model-blind Kernel injection and owner-only recovery
- A disabled-by-default financial sandbox with exact typed approval, limits, receipts, and no real-money provider
- Destructive actions with an additional typed owner-confirmation phrase
- Direct OpenAI, Anthropic, and Google model access, plus optional OpenRouter, Vercel AI Gateway, and OpenAI-compatible providers
- Vercel deployment with a cron-driven consumer, or a continuously running Docker worker
- CLI-friendly setup, diagnostics, webhook registration, and smoke checks

## Fastest setup

The recommended path uses Vercel Hobby, hosted Supabase, and an agent with authorized Supabase and Vercel integrations. The agent handles non-secret work and pauses before creating projects, storing credentials, changing production auth, or deploying publicly.

Open this repository in Codex or another capable coding agent and ask:

> Set up OpenInstinct using my connected Supabase and Vercel accounts. Follow AGENTS.md and docs/agent-setup.md, and pause before creating projects, storing credentials, changing production auth, or deploying publicly.

There are two setup milestones:

- **Bootstrap:** the owner-only web control plane, database, model, and scheduler are deployed. Blooio is not required.
- **Ready:** the public URL and Blooio iMessage integration are configured and verified.

Google Gmail and Calendar and the Kernel browser are optional post-deploy integrations.

### Before you start

You need:

- Git, Node 22+, and pnpm 10;
- Supabase and Vercel accounts;
- authorized Supabase and Vercel integrations for your agent, when available;
- the Vercel CLI installed and authenticated for the documented environment-sync and deployment commands (`pnpm add --global vercel`).

The Supabase CLI is already a repository development dependency. Project creation, paid-plan choices, credential storage, production auth changes, public deployment, and webhook registration always require owner confirmation.

### Phase 1: Prepare the repository

```bash
git clone https://github.com/zoltlabs/OpenInstinct.git openinstinct
cd openinstinct
corepack enable
pnpm install
pnpm --silent run doctor -- --target vercel --phase bootstrap --json
pnpm --silent run setup -- --target vercel --database hosted --json
```

The first `doctor` usually exits with code `2` and reports missing configuration; that is expected. `setup` then creates `.env.local`, generates local cryptographic secrets, selects Vercel AI Gateway by default, and returns ordered `checks` and `actions`. It should return `ok: true`, `bootstrapReady: false`, `ready: false`, and `milestone: "local"` at this stage. `ready` is reserved for the public HTTPS + Blooio milestone. Use `pnpm --silent run ...` whenever stdout must be directly parseable JSON.

### Optional: try one message before deploying

Open the private setup form and select a direct model provider plus its API key, or add a Vercel AI Gateway API key for local use:

```bash
pnpm run openinstinct -- setup-ui
pnpm run openinstinct -- try-message --message "What can you help me with?"
```

This preview calls only the configured model. It does not use Supabase, Blooio, connectors, durable memory, approvals, or external actions, and it says so in its output. It is a quick product preview rather than an end-to-end deployment test.

### Phase 2: Configure the owner and Supabase

1. Use the authorized Supabase integration to select a project. Ask before creating one.
2. Start the private setup form, which opens automatically in the default browser:

   ```bash
   pnpm run openinstinct -- setup-ui
   ```

   Use `--no-open` to print the loopback URL without launching a browser.

3. The owner enters `OWNER_EMAIL` and the Supabase pooler or direct Postgres `DATABASE_URL`, saves, and then stops the local form with Ctrl-C. Other integration fields can remain blank.
4. Link Supabase and apply the schema:

   ```bash
   pnpm exec supabase login
   pnpm run openinstinct -- configure-supabase --project-ref <project-ref> --use-env-database-url
   pnpm exec supabase db push --linked
   ```

`configure-supabase` reads the database URL from `.env.local`, retrieves the project API keys without printing them, and keeps the file owner-readable only. Never pass a database password in command arguments.

### Phase 3: Link Vercel and configure the final URL

1. Run `vercel link`. If no project is linked, ask before creating one.
2. Read the assigned production domain and store it locally.
3. Configure Supabase Auth for that exact URL.

```bash
vercel link
pnpm run openinstinct -- set-app-url --url https://your-production-url.example
```

In Supabase Auth, set:

- Site URL: the exact `NEXT_PUBLIC_APP_URL`
- Allowed redirect: `<NEXT_PUBLIC_APP_URL>/api/auth/callback`

Changing production Auth settings requires owner confirmation.

### Phase 4: Validate and deploy the core

```bash
pnpm --silent run doctor -- --target vercel --phase bootstrap --json
pnpm run openinstinct -- push-vercel-env --environment production
vercel deploy --prod
pnpm --silent run openinstinct -- configure-supabase-scheduler --json
pnpm --silent run smoke -- --url https://your-production-url.example --json
```

Ask before storing the production environment or deploying. The scheduler command stores the protected consumer URL and `INTERNAL_API_SECRET` in Supabase Vault, then creates an idempotent one-minute Supabase Cron job. At the end of this phase, the core control plane is deployed.

### Phase 5: Enable iMessage and reach ready

1. Open Blooio from `setup-ui`. The owner completes Blooio account verification and billing, provisions the assistant number, and creates an API key assigned to it. OpenInstinct never purchases or cancels a Blooio line.
2. Save the owner phone and API key privately, then click **Verify Blooio**. If the API key has exactly one active number, the wizard captures its channel automatically. The equivalent agent-safe command is `pnpm --silent run openinstinct -- configure-blooio --use-env-api-key --json`.
3. Ask before registering the production webhook. Click **Register webhook** in the wizard or use the CLI command below.
4. Synchronize the new environment and redeploy.

```bash
pnpm run openinstinct -- create-blooio-webhook \
  --url https://your-production-url.example --env-file .env.local
pnpm run openinstinct -- push-vercel-env --environment production
vercel deploy --prod
pnpm --silent run doctor -- --target vercel --phase ready --json
pnpm --silent run smoke -- --url https://your-production-url.example --json
```

Webhook registration is recoverable: the command lists existing subscriptions, reuses an exact match when its secret is already stored, and rotates the matching webhook secret when local recovery is needed. It never blindly creates a second matching webhook, and it never displays the secret. Open the deployed URL, request the owner magic link using `OWNER_EMAIL`, and onboard with the exact E.164 value in `BLOOIO_OWNER_PHONE`. The database enforces one owner workspace per deployment.

### Phase 6: Add optional integrations

- Gmail and Calendar: follow the [Google setup runbook](./docs/google-setup.md).
- Kernel cloud browser: add `KERNEL_API_KEY` through `setup-ui`.
- Other hosts and schedulers: see [deployment details](./docs/deployment/README.md).

After changing production environment variables, synchronize them and redeploy. Allowlisted values flow over stdin and are not printed or placed in shell history. Use the equivalent secret manager for non-Vercel hosts.

## Environment

Copy [`.env.example`](./.env.example). The setup command generates the cryptographic values and the setup tools populate provider values without displaying secrets.

Required for the core deployment:

| Variable                               | Purpose                                               |
| -------------------------------------- | ----------------------------------------------------- |
| `NEXT_PUBLIC_APP_URL`                  | Canonical HTTPS control-plane URL                     |
| `NEXT_PUBLIC_SUPABASE_URL`             | Supabase project URL                                  |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Browser-safe publishable key                          |
| `SUPABASE_SECRET_KEY`                  | Server-only Supabase secret key                       |
| `DATABASE_URL`                         | Direct or pooler Postgres URL; use SSL remotely       |
| `SECRET_ENCRYPTION_KEY`                | Base64 32-byte AES key for connector credentials      |
| `OWNER_EMAIL`                          | The only email allowed to sign in and claim ownership |
| `AI_PROVIDER`                          | Direct or optional routing provider                   |
| `AI_MODEL`                             | Provider-native model id                              |
| Selected provider credential           | The matching server-only API key described below      |
| `INTERNAL_API_SECRET`                  | Protects non-Vercel queue-consumer calls              |

Additionally required for iMessage-ready status:

| Variable                | Purpose                                              |
| ----------------------- | ---------------------------------------------------- |
| `BLOOIO_API_KEY`        | Blooio v4 API key                                    |
| `BLOOIO_WEBHOOK_SECRET` | One-time secret returned when the webhook is created |
| `BLOOIO_OWNER_PHONE`    | The sole owner’s E.164 phone number                  |

`BLOOIO_CHANNEL_ID` is optional unless the provisioned Blooio configuration requires an explicit sending channel.

`BLOOIO_OWNER_PHONE` is bootstrap input: onboarding verifies and stores it in `owner_phone_numbers`. That durable verified row becomes the runtime authority for inbound and outbound delivery, so changing only the environment value after onboarding does not redirect messages. `CREDENTIAL_VAULT_KEYS` is required before storing website credentials; `pnpm setup` generates the versioned wrapping-key JSON.

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
pnpm --silent run setup -- --target <vercel|vercel-pro|vercel-cloudflare|aws|gcp|docker> --database hosted --json
pnpm --silent run doctor -- --target <target> --phase bootstrap --json
```

Commands use stable exit codes: `0` success, `2` missing setup, `3` failed smoke check. `--json` emits machine-readable checks and external-action metadata. Agents should prefer purpose-built MCP/API integrations, then CLIs, then browser control. They must pause at project creation, credential generation, paid-plan selection, and other consequential provider actions. Secrets enter through hidden prompts, stdin, OAuth, or provider secret stores and are never included in an agent prompt or command arguments.

Vercel Hobby is intended for personal, non-commercial deployments. For commercial deployments that must remain independent of Vercel, use the Cloud Run or self-hosted Docker profile.

## Trust model

Read-only Google calls may execute automatically. Gmail drafts and Calendar writes are persisted first and require owner approval. Generic MCP invocation is currently denied even after connection and discovery; enabling it requires a reviewed semantic adapter with idempotency and read-back evidence. Security-setting changes are denied. Approval records bind to the SHA-256 hash of canonical tool input plus the exact connector account/configuration version, and execution rechecks provider/tool allowlists. Ambiguous provider outcomes are marked `unknown` and never retried automatically.

This is personal automation software with access to sensitive data. Review [`SECURITY.md`](./SECURITY.md) before exposing it publicly.

## License

MIT
