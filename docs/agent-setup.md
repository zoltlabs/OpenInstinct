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

## Hosted-first sequence

1. Read `AGENTS.md` and `docs/agent-overview.md`.
2. Run `pnpm install` and `pnpm run setup -- --target vercel --database hosted --json`. A successful preparation returns `ok: true`; `ready: false` is expected until provider setup is complete.
3. Parse the ordered `actions`. Use the connected integrations for provider work and the listed commands for local work.
4. Discover a suitable Supabase project. If none exists, request confirmation and create one through the Supabase integration.
5. Start `pnpm run openinstinct -- setup-ui` for the owner to enter `OWNER_EMAIL` and the Postgres connection URL privately. Then run `configure-supabase` as listed in the action plan and apply the migrations.
6. Link or create the Vercel project. Read its assigned default production domain through the Vercel integration and run `pnpm run openinstinct -- set-app-url --url <production-url>`.
7. Through the Supabase integration, set the Auth Site URL to the final app URL and allow the exact `<app-url>/api/auth/callback` redirect.
8. Run `doctor --phase bootstrap`, synchronize the production environment to Vercel, request deployment confirmation, and deploy once.
9. Run `configure-supabase-scheduler`; it stores the protected URL and bearer secret in Supabase Vault without displaying either value.
10. Run the deployed smoke check. The base control plane is now deployed.
11. Optionally configure Google with `gcloud` or the Google Cloud console, Kernel, and Blooio. Blooio is required for iMessage operation but not for deploying the control plane. After creating its webhook, synchronize the environment and redeploy once.
12. Run `doctor --phase ready`, the smoke check, and owner magic-link onboarding.

## Expected pauses

A fully unattended run is intentionally not the goal. A normal agent-run setup should need short user handoffs for provider login, persistent credential creation, any paid-plan decision, and hidden entry of the Supabase database URL. Everything between those boundaries should be executable and verifiable by the agent.

## Recovery

All setup commands are safe to rerun except external create/deploy/webhook operations. Before retrying one of those, discover the current provider state first. Never create a second project or webhook merely because a previous command timed out.
