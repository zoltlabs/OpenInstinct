# OpenInstinct agent instructions

OpenInstinct is a one-owner-per-deployment personal assistant. Supabase owns durable state; compute providers are replaceable. Never introduce a provider-specific dependency into `packages/core`, `packages/db`, `packages/messaging`, or `packages/connectors`.

## Required workflow

1. Run `pnpm run doctor -- --json` before setup or infrastructure work.
2. Read the local package documentation before changing AI SDK, Next.js, or Supabase integrations.
3. Never request or print secrets. Secret values enter through hidden prompts, OAuth, stdin, or provider secret stores.
4. Webhook ingestion must be idempotent. Consequential actions must use provider idempotency when available; otherwise persist `unknown` outcomes and never retry automatically.
5. All tables exposed through Supabase's Data API require explicit grants and tested RLS.
6. Run `pnpm check`, `pnpm build`, and `pnpm run smoke -- --json` before handoff.

## Ownership

- `packages/core`: state machine, policy, approvals, domain schemas.
- `packages/db`: Supabase/Postgres repositories and queue access.
- `packages/messaging`: Blooio protocol adapter only.
- `packages/connectors`: Google and MCP connectors.
- `packages/browser`: cloud-browser provider contract and Kernel adapter.
- `packages/runtime`: portable environment and deployment contracts.
- `apps/worker`: bounded queue consumer.
- `apps/web`: control plane and webhook ingress.
- `apps/cli`: setup, provisioning, diagnostics, and smoke tests.

Do not duplicate domain types. Export Zod schemas from the package that owns the boundary and infer TypeScript types from them.
