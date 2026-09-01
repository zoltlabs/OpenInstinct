# Master Codex implementation prompt

Use the text below to run the personal execution platform program sequentially in one checkout.

---

Implement the OpenInstinct personal execution platform end-to-end, sequentially in the current checkout on `main`. I explicitly authorize bounded subagents for read-only research, security review, database/RLS review, test design, and code review. Do not use git worktrees. The primary agent is the only writer; never let multiple agents edit the shared checkout concurrently.

Create a persistent goal for this program and continue across context compactions until every in-scope phase is complete or a genuine user-authority blocker is reached.

Before acting:

1. Read `AGENTS.md` and `docs/agent-overview.md` completely.
2. Read `docs/plans/personal-execution-platform.md` and both ADRs in `docs/decisions/` completely.
3. Run `pnpm --silent run doctor -- --json`.
4. Inspect `git status`; preserve and never include unrelated changes in phase commits.
5. Read local package documentation before changing AI SDK, Next.js, Supabase, or provider integrations.

Do not stop after producing another plan. Implement the code in the phase order defined by `docs/plans/personal-execution-platform.md`. At the start of each phase, state its scope and invariants. At the end of each phase:

- run a read-only security diff review with a subagent;
- run a state/retry review and database/RLS review where applicable;
- fix validated findings;
- run `pnpm check`, `pnpm build`, `pnpm supabase:test`, and the applicable JSON smoke test;
- commit only the phase's files with a descriptive commit;
- report the commit hash and continue automatically.

The credential architecture is fixed unless a demonstrated security flaw requires an ADR change:

- OAuth/API connector tokens remain encrypted in OpenInstinct's connection records.
- Website usernames/passwords are stored in OpenInstinct's internal Supabase vault: safe metadata in `public.credential_items` and encrypted payloads in `app_private.credential_secrets` with no Data API grants. Only narrowly scoped server-side `packages/db` methods may access ciphertext; Supabase browser clients never can.
- Each credential uses a random data-encryption key wrapped by a dedicated versioned credential-vault key or KMS key. Do not reuse the connector `SECRET_ENCRYPTION_KEY` as the long-term vault key.
- `packages/db` owns SQL and encryption-at-rest repositories. `packages/credentials` owns origin validation, model-blind injection orchestration, metadata types, and redaction helpers.
- Kernel stores secret-bearing browser cookies/session state, not website password source-of-truth records.
- The model may choose credential metadata but never receives, serializes, logs, types, or observes plaintext.
- The trusted worker injects a selected credential only into an exact-origin, workspace-bound, exclusively leased browser session. Disable screenshots/replay around injection and audit metadata before and after use.
- OTP, TOTP, passkeys, recovery codes, security answers, CAPTCHA, and payment secrets require owner takeover initially. Gmail and messaging reads must redact likely OTP/recovery/security-challenge content before model context.
- 1Password, Bitwarden, Kernel Managed Auth, and other external vaults are optional post-MVP adapters. Do not research, require, or implement them during the core program.

Preserve these execution rules:

- Supabase is the durable source of truth; use Supabase Storage as the default artifact byte store.
- Split adaptive computer use into short durable queue slices. Do not rely on a long-lived HTTP request, worker process, browser connection, or provider callback.
- Report when scheduler-only deployment cannot meet interactive latency; support a continuous-worker profile for takeover and responsive computer use.
- Use connectors before browser, browser before VM, and VM before a dedicated mobile device.
- Never use VM/device execution to evade site access controls, CAPTCHA, bot restrictions, or terms.
- Preserve exact semantic intent, configuration versions, commit guard conditions, postcondition evidence, and no-replay-on-ambiguity behavior for every consequential action.
- Financial work remains sandbox/test-only until all financial launch gates pass; never spend real money.
- Shared public device farms never receive owner credentials.

Use additive migrations only. Every exposed table requires constraints, intentional grants, RLS, and SQL tests. Provider-specific dependencies remain outside `packages/core`, `packages/db`, `packages/messaging`, and `packages/connectors`. Do not duplicate domain types.

Continue when a blocker affects only optional live-provider verification: record the missing check, use provider fakes and contract tests, and proceed with independent work. Stop and ask me only when real credentials, paid resource creation, production mutation, real external communication, real money, a material unresolved architecture choice, or an unavoidable overlap with unrelated changes requires authorization.

At final handoff provide phase commit hashes, implemented capabilities, migrations, verification and security-review results, provider-live checks still requiring the owner, VM/mobile build-or-defer decisions, residual credential-processing risks, and remaining production launch gates.
