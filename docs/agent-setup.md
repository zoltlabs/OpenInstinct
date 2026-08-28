# Agent-operated setup

This runbook is for Codex or another local coding agent with shell access, provider integrations, and optional computer control. Hosted Supabase is the default. Local Supabase is only for database development and SQL tests.

## Tool order

Use the narrowest available tool in this order:

1. Authorized provider MCP or API integration
2. Provider CLI
3. Browser/computer control

Use browser control only for steps the integration or CLI cannot perform safely. Re-inspect the page after every navigation or mutation. Never copy a secret into chat, browser-visible output, command arguments, logs, or source control.

## Confirmation boundaries

Read-only discovery needs no confirmation. Pause immediately before:

- creating a Supabase, Vercel, Cloudflare, Blooio, Google, or Kernel project;
- choosing or upgrading a paid plan;
- generating a credential or granting persistent OAuth access;
- deploying publicly, registering the production webhook, or changing production auth/security settings.

The user should type existing credentials into provider UI or a hidden terminal prompt. `configure-supabase` accepts the database URL through a hidden prompt or stdin and never prints it.

## Hosted-first sequence

1. Read `AGENTS.md` and `docs/agent-overview.md`.
2. Run `pnpm install` and `pnpm run setup -- --target vercel --database hosted --json`.
3. Parse `checks` and `actions`; do not scrape the human-readable output.
4. Authenticate provider CLIs through their normal OAuth/login flows.
5. Discover an existing Supabase project. If none is suitable, request confirmation, then create one with Supabase MCP/API; use computer control as fallback. Do not pass a database password to `supabase projects create` because that CLI exposes it in argv.
6. Run `pnpm run openinstinct -- configure-supabase --project-ref <ref>`. Have the user paste the Postgres connection URL into the hidden prompt. The command links the project, captures API keys without printing them, and updates `.env.local` with mode `0600`.
7. Set the hosted Supabase Auth Site URL to `NEXT_PUBLIC_APP_URL` and add `NEXT_PUBLIC_APP_URL/api/auth/callback` as an exact redirect URL.
8. Run `pnpm exec supabase db push --linked`.
9. Configure the remaining provider values through hidden prompts or secret stores, then run `doctor --phase bootstrap`.
10. Link the compute target. For Vercel, run `push-vercel-env`; it sends allowlisted values over stdin and suppresses provider output, then deploy. For Vercel Hobby, also deploy the included Cloudflare scheduler and its two secrets.
11. Register the Blooio webhook. Run `push-vercel-env` again to store the captured signing secret, then redeploy.
12. Run `doctor --phase ready` and `smoke --json`, then complete owner magic-link onboarding.

## Expected pauses

A fully unattended run is intentionally not the goal. A normal agent-run setup should need short user handoffs for provider login, persistent credential creation, any paid-plan decision, and hidden entry of the Supabase database URL. Everything between those boundaries should be executable and verifiable by the agent.

## Recovery

All setup commands are safe to rerun except external create/deploy/webhook operations. Before retrying one of those, discover the current provider state first. Never create a second project or webhook merely because a previous command timed out.
