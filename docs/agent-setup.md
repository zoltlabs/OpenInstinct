# Agent-operated setup

This runbook is for Codex or another local coding agent. The normal path assumes authorized Supabase and Vercel integrations. With those connected, the agent should complete every non-secret step and pause only at the confirmation boundaries below. Hosted Supabase is the default; local Supabase is only for database development and SQL tests.

`gcloud` is optional. Use it only when the owner enables Gmail and Calendar after deployment. Blooio and Kernel are also post-deploy integrations and must not block the base Supabase/Vercel deployment.

## Tool order

Use the narrowest available tool in this order:

1. Authorized Supabase or Vercel MCP/API integration
2. Provider CLI
3. Browser/computer control

Use browser control only for steps the integration or CLI cannot perform safely. Re-inspect the page after every navigation or mutation. Never copy a secret into chat, browser-visible output, command arguments, logs, or source control.

## Confirmation boundaries

Read-only discovery needs no confirmation. Pause immediately before:

- creating a Supabase, Vercel, Blooio, Google, Kernel, or optional Cloudflare project;
- choosing or upgrading a paid plan;
- generating a credential or granting persistent OAuth access;
- deploying publicly, registering the production webhook, or changing production auth/security settings.

The user should type existing credentials into provider UI or a hidden terminal prompt. `configure-supabase` accepts the database URL through a hidden prompt or stdin and never prints it.

## Milestones

- **Bootstrap:** the database, owner-only control plane, model, and scheduler are deployed. Blooio is not required.
- **Ready:** the final public URL and Blooio iMessage integration are configured and verified.

## Hosted-first phase checklist

### Phase 1: Prepare locally

1. Read `AGENTS.md` and `docs/agent-overview.md`.
2. Run `pnpm install`.
3. Run `pnpm run doctor -- --target vercel --phase bootstrap --json` before setup. Exit code `2` and missing-configuration checks are expected on a fresh clone.
4. Run `pnpm run setup -- --target vercel --database hosted --json`. Require `ok: true`; `ready: false` remains expected.
5. Parse the ordered `actions`. Use connected integrations for provider work and the listed commands for local work.

### Phase 2: Configure the owner and Supabase

1. Discover a suitable Supabase project. If none exists, request confirmation and create one through the Supabase integration.
2. Start `pnpm run openinstinct -- setup-ui`. It opens the loopback wizard automatically; use `--no-open` when the agent should only report the URL.
3. Ask the owner to enter only `OWNER_EMAIL` and the Postgres `DATABASE_URL` needed for this phase. Blank fields preserve existing values. Stop the form after the owner saves.
4. Run `pnpm exec supabase login` if the CLI is not authenticated.
5. Run `pnpm run openinstinct -- configure-supabase --project-ref <project-ref> --use-env-database-url`.
6. Run `pnpm exec supabase db push --linked`.

### Phase 3: Configure Vercel and Supabase Auth

1. Link or create the Vercel project with `vercel link`. Ask before project creation.
2. Read its assigned production domain and run `pnpm run openinstinct -- set-app-url --url <production-url>`.
3. Through the Supabase integration, set the Auth Site URL to the exact production URL and allow the exact `<production-url>/api/auth/callback` redirect. Ask before changing production Auth settings.

### Phase 4: Deploy the core

1. Run `pnpm run doctor -- --target vercel --phase bootstrap --json` and resolve every failed check.
2. Ask before credential storage, then run `pnpm run openinstinct -- push-vercel-env --environment production`.
3. Ask before public deployment, then run `vercel deploy --prod`.
4. Run `pnpm run openinstinct -- configure-supabase-scheduler --json`. It stores the protected URL and bearer secret in Supabase Vault without displaying either value.
5. Run `pnpm run smoke -- --url <production-url> --json`. The core control plane is now deployed.

### Phase 5: Enable iMessage and verify ready

1. Optionally configure Google and Kernel after deployment. Neither blocks ready status.
2. Open Blooio for the owner. The owner creates or selects their account, completes any KYC and billing, provisions the assistant number, and creates an API key assigned to that number. The agent may navigate to the relevant page, but it must not accept a paid plan or enter credentials for the owner.
3. In `setup-ui`, the owner privately saves `BLOOIO_OWNER_PHONE` and `BLOOIO_API_KEY`, then clicks **Verify Blooio**. The read-only verification discovers active channels and captures `BLOOIO_CHANNEL_ID` automatically when exactly one exists. The CLI equivalent is `pnpm run openinstinct -- configure-blooio --use-env-api-key --json`.
4. Ask before webhook registration. The owner can click **Register webhook** in the wizard, or the agent can run `pnpm run openinstinct -- create-blooio-webhook --url <production-url> --env-file .env.local`. The operation lists existing subscriptions first; it reuses a matching webhook or rotates its secret for recovery instead of creating a duplicate.
5. Synchronize the changed environment and redeploy, with confirmation at both boundaries.
6. Run `pnpm run doctor -- --target vercel --phase ready --json` and `pnpm run smoke -- --url <production-url> --json`.
7. Open the control plane for owner magic-link onboarding.

## Expected pauses

A fully unattended run is intentionally not the goal. A normal agent-run setup should need short user handoffs for provider login, persistent credential creation, any paid-plan decision, hidden entry of the Supabase database URL, and Blooio account/number provisioning. Everything between those boundaries should be executable and verifiable by the agent.

## Recovery

All setup commands are safe to rerun except external create/deploy/webhook operations. Before retrying one of those, discover the current provider state first. Never create a second project or webhook merely because a previous command timed out.
