# Agent overview

Read this first when extending OpenInstinct. It describes what the system is, where behavior lives, which invariants must survive every change, and the shortest safe path for adding features.

The source of truth, in descending order, is:

1. Database migrations and executable domain code
2. Tests
3. This overview and the other documentation

If the code and this document disagree, confirm the intended behavior, fix both, and add a regression test.

## Product contract

OpenInstinct is an open-source personal assistant for one owner per deployment. The owner talks to it through iMessage via Blooio v4. A small web control plane exists only for onboarding, connectors, approvals, and audit visibility; do not turn it into another chat interface.

The assistant can read connected services, reason over recent conversation context, propose consequential actions, and execute an approved proposal. Supabase Postgres is the durable source of truth. Web and worker compute can move between providers without changing the domain model.

Current integrations are:

- Blooio v4 for inbound and outbound iMessage
- Google OAuth for Gmail and Calendar
- Curated and registry-resolved remote MCP over HTTPS for long-tail connectors,
  including per-owner browser OAuth
- Kernel behind a provider-neutral cloud-browser interface
- Direct OpenAI, Anthropic, and Google inference with optional OpenRouter, Vercel AI Gateway, or OpenAI-compatible endpoints
- Vercel, containers, or other Node hosts for compute
- Supabase Postgres, Auth, Row Level Security, and `pgmq`

## Runtime in one minute

```mermaid
flowchart LR
  Owner[iMessage owner] --> Blooio[Blooio v4]
  Blooio -->|signed raw webhook| Web[apps/web]
  Web -->|event + run, one transaction| DB[(Supabase Postgres)]
  DB --> Queue[pgmq agent_jobs]
  Queue --> Worker[apps/worker]
  Worker --> Model[AI model]
  Worker --> Read[read-only tools]
  Worker --> Proposal[action request]
  Proposal -->|owner approves exact hash| Queue
  Queue --> Execute[revalidate and execute]
  Execute --> Blooio
```

1. `apps/web` verifies the Blooio signature against the exact, size-bounded raw request body before parsing it.
2. `packages/db` deduplicates the provider event and atomically creates the message, agent run, and `process_event` queue job.
3. `apps/worker` claims the durable job, loads bounded context, and runs the agent for a bounded number of steps.
4. Safe reads may execute inline. A consequential operation becomes an immutable `action_request` containing a structured semantic intent, exact executable-input hash, and guard-condition hash.
5. Deterministic policy either denies the action, requires exact owner approval, or atomically reserves a matching bounded authority grant. Destructive actions always require fresh typed confirmation. Financial commits are limited to the explicitly enabled sandbox pilot and also require fresh typed confirmation; security commits remain denied.
6. Approval or a valid grant queues `resume_run`. The worker reacquires the run lease, revalidates origin/account/recipient/configuration guards immediately before the invocation fence, and executes only the stored payload.
7. A successful semantic action requires read-only postcondition evidence. An ambiguous outcome becomes `unknown`, is never replayed, and creates a durable read-only reconciliation case.
8. The result, evidence metadata, audit trail, and continuation outbox are persisted, and a deterministic outbound message is sent through Blooio.

HTTP requests are triggers, not the source of truth. Durable state and the queue live in Postgres.

## Non-negotiable invariants

Preserve these in every feature:

1. **One owner, one deployment.** `OWNER_EMAIL`, the exact E.164 owner phone, database constraints, and RLS all enforce the boundary. Do not generalize to multi-tenant behavior accidentally.
2. **Authenticate before parsing or acting.** Verify public webhook signatures against raw bytes, enforce body limits, and authenticate internal routes with server-only secrets.
3. **Ingestion is idempotent.** A provider retry must not create another run. Keep event insertion and job creation atomic.
4. **The queue is authoritative.** Never rely on an in-memory task, a long-lived HTTP request, or a provider callback alone for durable progress.
5. **The model cannot directly perform consequential actions.** Reads can be automatic. Writes and communications require a persisted proposal and policy decision. Financial actions are confined to the reviewed sandbox pilot with exact preflight approval; destructive and security actions fail closed unless an explicit reviewed path exists.
6. **Approval binds exact intent.** Hash canonical input and include the exact connector account/configuration version. Execute the stored payload; never ask the model to recreate it after approval.
7. **Revalidate at execution time.** Confirm workspace, action state, expiry, provider, connector, tool allowlist, account, and configuration version immediately before the side effect.
8. **Ambiguous writes are not retried.** Prefer provider idempotency keys. If a timeout or crash leaves completion uncertain, record `unknown`, notify the owner, and require reconciliation instead of replaying it.
9. **Secrets stay server-side and encrypted.** Connector credentials are AES-256-GCM encrypted at rest. Never put tokens in model context, browser output, logs, CLI arguments, committed files, or client-visible API responses.
10. **Remote MCP is hostile input.** Require HTTPS, block redirects and private/special IP ranges at the transport layer, bound responses, validate schemas, and require approval for every MCP invocation.
11. **Database exposure is explicit.** Every Data API table needs intentional grants, RLS, and SQL tests. Workers use direct Postgres credentials; browsers receive only owner-safe views and server-mediated operations.
12. **Provider code stays at the edge.** Core policy and state must not depend on Vercel, Blooio, Google, Kernel, or a specific model provider.
13. **Model fallback is step-local and explicit.** A configured fallback may retry a failed generation before its tool call executes. Never restart an entire agent run for provider failover because earlier tool calls may already have completed.

## Repository map

| Area                         | Owns                                                                                                          | Start here                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `apps/web`                   | Owner control plane, auth, onboarding, public webhooks, connector callbacks, approvals, bounded queue trigger | `app/api/webhooks/blooio/route.ts`, `app/api/approvals/[id]/route.ts`, `app/api/internal/consume/route.ts`, `proxy.ts` |
| `apps/worker`                | Agent tools, direct model providers and fallback, job processing, side-effect execution, retries              | `src/models.ts`, `src/agent.ts`, `src/processor.ts`, `src/consumer.ts`                                                 |
| `apps/cli`                   | Agent-friendly setup, diagnostics, webhook provisioning, smoke tests                                          | `src/index.ts`                                                                                                         |
| `packages/core`              | Provider-independent schemas, canonical hashing, policy, run state machine, system prompt                     | `src/domain.ts`, `src/policy.ts`, `src/state-machine.ts`, `src/prompt.ts`                                              |
| `packages/db`                | The only direct SQL access layer, repositories, encrypted credentials, queue and scheduler configuration      | `src/store.ts`, `src/jobs.ts`, `src/scheduler.ts`, `src/crypto.ts`                                                     |
| `packages/messaging`         | Blooio v4 protocol, signature verification, message normalization and sending                                 | `src/client.ts`, `src/signature.ts`, `src/types.ts`                                                                    |
| `packages/connectors`        | Direct Google OAuth/API and generic remote MCP transports                                                     | `src/google.ts`, `src/mcp.ts`, `src/types.ts`                                                                          |
| `packages/browser`           | Provider-neutral browser contract and Kernel adapter                                                          | `src/provider.ts`, `src/kernel.ts`                                                                                     |
| `packages/computer`          | Conditional VM/device contract proposal and evidence-based build gate; no production adapter                  | `src/provider.ts`, `src/gate.ts`, `docs/vm-decision-spike.md`                                                          |
| `packages/credentials`       | Provider-neutral credential schemas, envelope encryption, origin rules, and secret-message filtering          | `src/envelope.ts`, `src/broker.ts`, `src/redaction.ts`                                                                 |
| `packages/runtime`           | Environment validation and portable deployment contracts                                                      | `src/env.ts`, `src/deployment.ts`                                                                                      |
| `supabase`                   | Schema, constraints, RLS, grants, functions, `pgmq`, database tests                                           | `migrations/20260827185247_initial_schema.sql`, `tests/schema.test.sql`                                                |
| `infra/cloudflare-scheduler` | Optional advanced one-minute trigger for the bounded consumer endpoint                                        | `src/index.ts`, `wrangler.jsonc`                                                                                       |
| `docs/deployment`            | Supported hosting profiles and secret wiring                                                                  | `README.md`                                                                                                            |

Do not duplicate domain types. Put a Zod schema at the package boundary that owns the data and infer its TypeScript type.

## State and data model

The important durable records are:

- `workspaces` and `owner_phone_numbers`: singleton ownership boundary
- `conversations`, `messages`, and `inbound_events`: messaging history and deduplication
- `agent_runs`: durable orchestration state
- `action_requests` and `approvals`: immutable proposed intent and owner decision
- `authority_grants` and `authority_usages`: versioned owner authority and atomic per-action reservations
- `action_evidence` and `reconciliation_cases`: bounded postcondition proof and no-replay unknown-outcome recovery
- `connections`: encrypted provider configuration and credentials
- `scheduled_triggers`: one-time reminders and fixed-interval recurring agent routines
- `memories`: owner-approved long-term context with explicit save/forget operations and vector-ready storage
- `audit_events`: security-relevant history
- `browser_profiles`: references to provider-side browser state, not raw secrets
- `credential_items` and `credential_access_events`: owner-safe vault metadata and append-only access history; ciphertext and injection leases remain in `app_private`
- `financial_settings`, `financial_merchants`, and `payment_aliases`: owner-controlled sandbox kill switch, limits, allowlist, and safe payment metadata
- `financial_transactions`, `spend_ledger`, and `financial_receipts`: durable sandbox order state and append-only financial evidence; exact preflights and provider handles remain in `app_private`

Run states are defined in `packages/core/src/domain.ts` and enforced by `state-machine.ts`:

```text
queued -> running -> completed
                  -> waiting_approval -> queued
                  -> waiting_event -> queued
                  -> failed -> queued
                  -> cancelled
```

Action states are:

```text
pending -> approved -> executing -> executed
                              \-> failed
                              \-> unknown
        -> denied
        -> expired
```

Do not add ad hoc status strings. Update the owning Zod schema, state rules, migration constraints if applicable, repository methods, and tests together.

## How to add a direct connector

Use a direct connector when scopes, data types, and risk are stable enough to model explicitly.

1. Add provider-neutral connector types in `packages/connectors/src/types.ts` and the provider implementation beside `google.ts`.
2. Keep OAuth and token refresh inside the connector package. Store encrypted credentials only through `packages/db`.
3. Add read tools in `apps/worker/src/agent.ts` with narrow Zod inputs and bounded outputs.
4. For a write, make the tool create an `ActionRequest`; do not call the provider from the model tool.
5. Build the provider-neutral semantic intent and guard snapshot from trusted adapter facts, not model-supplied risk labels or tool-name keywords.
6. Put all actual write execution in `apps/worker/src/processor.ts`. Revalidate connector id, exact origin, account/recipient identity, configuration version, semantic hashes, and grant reservation immediately before the invocation fence.
7. Use a deterministic provider id or idempotency marker where the API supports it, then perform a bounded read-back and persist evidence. Map ambiguous failures to `unknown` and provide a read-only reconciliation contract.
8. Add OAuth/control-plane routes in `apps/web`, environment validation in `packages/runtime`, and setup/doctor support in `apps/cli`.
9. Add unit tests, database tests if storage changes, and an end-to-end smoke path that does not expose credentials.

## How to extend generic MCP

MCP is the long-tail integration path. Keep the existing network protections in `packages/connectors/src/mcp.ts`; application-level URL checks alone are insufficient because DNS can change between validation and connection.

- Put stable, reviewed endpoints and aliases in `packages/connectors/src/mcp-catalog.ts`. Unknown names may fall back to the official MCP registry, but registry metadata remains untrusted and owner-visible before connection.
- Resolve conversational requests with the bounded `resolveConnector` agent tool. It returns an authenticated control-plane link; it never receives credentials or completes authorization inside iMessage.
- Register configuration through the authenticated web control plane. Standard MCP OAuth uses a short-lived, connection-bound state and PKCE, persists intermediate and refreshed credentials encrypted, and completes in the owner's browser. Bearer tokens remain a legacy fallback entered only in the web form.
- Discover and expose only explicitly allowed tools.
- Treat tool descriptions and results as untrusted data, not instructions.
- Bound argument and response sizes.
- Persist every invocation as an action request, even if the remote tool claims to be read-only. Generic MCP commits fail closed unless a reviewed adapter supplies a trusted semantic effect, idempotency, and read-back contract.
- Recheck the server and `configVersion` during execution.

## How to add another messaging channel

Keep Blooio behavior in `packages/messaging`; do not scatter provider payloads through core or worker code.

1. Define a normalized inbound event and a channel-specific signature verifier/client.
2. Add a small ingress route that verifies raw bytes, applies a strict size limit, then normalizes.
3. Reuse the transactional ingestion method in `packages/db` and give provider event ids a collision-safe namespace.
4. Implement idempotent outbound delivery and deterministic message keys.
5. Preserve the one-owner allowlist before creating any run.

## How to add browser automation

Implement providers behind `BrowserProvider` in `packages/browser`. The current Kernel adapter bounds program size and runtime. Browser execution is intentionally not exposed as a free-form autonomous model tool.

Website credentials use `packages/credentials` and `app_private.credential_secrets`. The model may select metadata, but only the trusted broker can decrypt and inject into classified fields on an exact HTTPS origin. Never add a plaintext secret getter to a model-facing tool, action request, browser observation, log, or audit event. OTP, password-reset, recovery, and security-challenge messages are withheld and require owner takeover.

To expose a browser capability, define a narrow named operation, classify its risk, persist writes as action requests, and execute the approved operation in the worker. Never pass arbitrary credentials or an unrestricted browsing program from model output directly to a browser provider.

## How to extend the financial pilot

The only automated financial commit path is `openinstinct_sandbox`. It is disabled by default and requires both the global switch and an enabled canary merchant. Every purchase binds an immutable short-lived preflight containing the exact merchant, integer-minor-unit total, recurring terms, payment alias, and configuration versions. The approval page recomputes the exact typed phrase server-side, and the worker revalidates the same snapshot and rolling limits inside the commit transaction.

Never accept raw payment credentials in an agent tool or action request. A timeout after the invocation fence becomes `unknown` and is observed through the read-only transaction ledger; it is never purchased again automatically. Refunds and cancellations are distinct financial actions with fresh typed authorization, a credit ledger entry, and a separate receipt. Adding a real merchant or payment provider requires a reviewed adapter with provider idempotency and read-back evidence; generic browser or MCP execution is not a financial adapter.

## How to evaluate a VM provider

The VM layer is not enabled. `packages/computer` retains a provider-neutral contract and a fail-closed build gate, while [`vm-decision-spike.md`](vm-decision-spike.md) records the current no-build decision. Provider documentation is feasibility evidence, not a live demonstration. Do not add a provider SDK or operate a VM until two recurring owner workflows require it, browser and API alternatives fail measured tests, every lifecycle and security control is demonstrated against a real provider, and owner-visible cost passes an explicit ceiling.

## How to evaluate a mobile device

The mobile layer is deferred. [`mobile-decision-spike.md`](mobile-decision-spike.md) records the failed product-demand gate and the separate Android and iOS custody requirements. Never use a public shared device fleet with owner credentials. Do not provision a dedicated device until recurring mobile-only workflows are proven and test-account custody, encryption, bounded control, takeover, retention, reset, verified deletion, ambiguous outcomes, and owner-visible cost pass review.

## How to change the database

Create a new timestamped migration; never edit an already-applied migration after release.

- Add constraints as well as application validation.
- Enable RLS and write policies before granting Data API access.
- Keep encrypted columns inaccessible to browser roles; expose a safe view when necessary.
- Update `packages/db/src/store.ts` instead of issuing SQL from another package.
- Add or update `supabase/tests/schema.test.sql`.
- Test locally with `pnpm supabase:reset` and `pnpm supabase:test`.

## Common feature routing

| Change                   | Primary files                                                                             | Also inspect                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| New agent read tool      | `apps/worker/src/agent.ts`                                                                | connector implementation, prompt, output bounds, tests                    |
| New consequential action | `packages/core/src/policy.ts`, `apps/worker/src/agent.ts`, `apps/worker/src/processor.ts` | domain hash/schema, DB store, approval UI, idempotency tests              |
| New event or job type    | `packages/core/src/domain.ts`, `packages/db/src/jobs.ts`                                  | store transaction, consumer, state machine, migration constraints         |
| New OAuth provider       | `packages/connectors`, `apps/web/app/api/connectors`                                      | encrypted connection storage, runtime env, CLI doctor, callback allowlist |
| New hosting target       | `packages/runtime/src/deployment.ts`, `apps/cli/src/index.ts`                             | Dockerfiles, scheduler/worker mode, deployment docs                       |
| New model provider       | `apps/worker/src/models.ts`, `packages/runtime/src/env.ts`                                | provider package, CLI doctor, `.env.example`, fallback tests, README      |
| New owner-visible data   | migration, `packages/db/src/store.ts`, `apps/web`                                         | grants, RLS, safe views, SQL tests                                        |
| New proactive behavior   | `scheduled_triggers`, queue producer, worker                                              | owner controls, rate bounds, quiet hours, deduplication                   |

## Local workflow

Use Node 22 and pnpm 10.

```bash
corepack enable
pnpm install
pnpm --silent run setup -- --target vercel --database hosted --json
pnpm run openinstinct -- configure-supabase --project-ref <project-ref>
pnpm exec supabase db push --linked
pnpm --silent run doctor -- --target vercel --phase bootstrap --json
```

Hosted Supabase with Vercel is the normal setup path. Authorized Supabase and Vercel integrations are sufficient for the base deployment; `gcloud`, Blooio, and Kernel are optional post-deploy setup. The loopback setup UI renders the same ordered action plan used by agents and opens automatically unless `--no-open` is passed. Create the Vercel project before deploying, capture its assigned production domain with `set-app-url`, configure Supabase Auth against that URL, synchronize the environment, and deploy once. Use the local stack only for database development with `pnpm supabase:start` and `pnpm supabase:reset`.

The owner manages Blooio account creation, KYC, billing, number provisioning, and API-key creation in Blooio. OpenInstinct may verify the supplied key with a read-only channel listing, capture a unique active channel, and idempotently register or recover the production webhook after explicit confirmation. It never purchases or removes Blooio lines.

For setup or infrastructure work, run `doctor` before making changes. It emits machine-readable output and stable exit codes. `bootstrap` accepts the temporary local app URL and omits post-deploy integrations; `ready` requires a public HTTPS app URL and Blooio. Never print `.env.local` or pass secret values as CLI arguments. See `docs/agent-setup.md` for the ordered MCP-first flow and confirmation boundaries, and `docs/google-setup.md` for optional Gmail and Calendar OAuth.

Before handoff:

```bash
pnpm check
pnpm build
pnpm supabase:test
pnpm --silent run smoke -- --url http://localhost:3000 --json
```

Run the checks that require live services when those services are available. If one cannot run, report the exact missing dependency; do not describe it as passing.

## Deployment profiles

- **Lowest-friction hobby setup:** Vercel Hobby for `apps/web`, with Supabase Cron invoking the protected consumer once per minute and secrets held in Supabase Vault.
- **No Vercel:** deploy the web and worker container targets to Cloud Run or another Node/container host, with a scheduler invoking the bounded consumer if no continuous worker is running.
- **Self-hosted:** Docker Compose runs web and worker against the configured Supabase/Postgres project.
- **Lower latency:** run `apps/worker` continuously instead of waiting for a one-minute scheduler tick.

Compute must remain disposable. A deployment change must not move durable run or approval state out of Postgres.

## Definition of done

Before considering a feature complete, verify:

- The owner can discover and configure it without editing source code.
- Setup and health problems are visible through CLI `doctor` or the control plane.
- Inputs and outputs have schemas and size/time bounds.
- Public and internal entry points authenticate before work begins.
- Retries cannot duplicate inbound events, runs, messages, or external writes.
- Writes cross the proposal/approval/execution boundary and preserve the exact approved payload.
- Secrets remain encrypted, server-only, absent from logs, and ignored by Git.
- New database objects have constraints, least-privilege grants, RLS, and SQL tests.
- Failure, timeout, stale configuration, denial, expiry, and ambiguous completion paths are tested.
- `pnpm check`, `pnpm build`, relevant database tests, and the applicable smoke test pass.
- README, this overview, deployment docs, `.env.example`, and CLI help are updated when the operator experience changes.

## Current proactive, web, memory, and browser behavior

- Reminders deliver an idempotent iMessage at an exact timestamp. They may repeat at a bounded fixed interval.
- Scheduled routines inject their approved prompt as a durable scheduled event and run through the same agent queue, tool limits, policy, and approval boundary as owner messages.
- The worker includes a bounded set of recent owner-approved memories in each model run. It can search all active memories, propose new memories, and propose destructive forgetting.
- Public web fetch is read-only, HTTPS-only, response-bounded, redirect-free, and protected against private/special network destinations.
- Kernel may read a public page in an ephemeral browser. Persistent profiles and browser writes fail closed until the later lease, redaction, and semantic-authorization phases; arbitrary JavaScript is never accepted from the model.
- Any HTTPS MCP server can contribute discovered tools. The assistant invokes them through one generic, allowlist-checked action boundary; every invocation still requires approval, including tools described as read-only.
- Destructive connector operations require a hash-bound approval plus the control plane's exact destructive confirmation phrase. Generic browser writes, financial actions, and security-sensitive operations remain denied.

## Intentional limitations

- It is single-owner, not multi-tenant SaaS.
- The web app is a control plane, not a primary conversation surface.
- Generic MCP calls always require approval.
- Browser automation uses a bounded step language, not unrestricted model-generated code.
- Some APIs cannot prove whether a timed-out write completed. Those actions become `unknown` and require owner reconciliation.
- Recurrence is a fixed elapsed-time interval rather than a cron or calendar recurrence rule; local-time/DST-aware schedules need a future schema extension.

For architectural rationale, read [`architecture.md`](architecture.md). For operator steps, read [`deployment/README.md`](deployment/README.md). For disclosure and security expectations, read [`../SECURITY.md`](../SECURITY.md).
