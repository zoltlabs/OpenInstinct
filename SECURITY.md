# Security policy

Please report vulnerabilities privately through GitHub Security Advisories. Do not open public issues containing credentials, personal messages, OAuth tokens, webhook payloads, or exploit details.

## Deployment requirements

- Use a dedicated Supabase project and a dedicated Blooio API key.
- Keep `SUPABASE_SECRET_KEY`, `DATABASE_URL`, OAuth client secrets, Blooio secrets, AI keys, `SECRET_ENCRYPTION_KEY`, and `CREDENTIAL_VAULT_KEYS` server-only.
- Use HTTPS for every public callback and webhook.
- Restrict database network access where the host permits it and use SSL remotely.
- Rotate connector credentials and the Blooio API key after suspected exposure. Rotating `SECRET_ENCRYPTION_KEY` requires re-encrypting or reconnecting every connector. Website credentials use the separate versioned `CREDENTIAL_VAULT_KEYS` envelope; the current alpha has rewrap primitives but no bulk rotation command, so retain every old key version until all affected items have been rewrapped and verified through a reviewed operator procedure.
- Configure Supabase Auth redirect allowlists to the exact production origin. `OWNER_EMAIL` is the only address accepted by the app, and browser roles cannot create the owner workspace directly.

## Intentional safety boundaries

Consequential external actions require owner approval or an exact bounded authority grant. The authorization covers immutable semantic intent, input and guard hashes, and configuration versions, not a mutable model continuation. Generic MCP endpoints must be HTTPS, cannot redirect, and use a transport-level DNS check that rejects non-public destinations on every new socket. Generic MCP invocation currently remains denied until a reviewed semantic adapter supplies effect classification, idempotency, and read-back evidence. Apply outbound network policy in production as defense in depth.

When a provider response is ambiguous, OpenInstinct marks the action `unknown`, warns the owner, and never retries automatically. Calendar creates use a deterministic provider event ID; Gmail drafts and arbitrary MCP servers cannot provide a universal exactly-once guarantee.

Kernel automation is limited to adaptive read-only public-page research with bounded typed steps. Persistent authenticated research hands off to the owner because the current adapter cannot prove complete read-only network isolation; browser writes and arbitrary model-generated browser code remain disabled. Website credentials can be injected only by the trusted control plane into an exact-origin leased session without exposing plaintext to the model.

Real-money and security-sensitive operations remain denied. The only financial commit path is the disabled-by-default `openinstinct_sandbox` provider for non-production canary merchants. It requires merchant and global enablement, exact short-lived preflight approval, typed confirmation, limits, evidence, and unknown-outcome reconciliation.

## Data handling

OAuth/MCP credentials are encrypted with AES-256-GCM and workspace/connection-bound associated data. Website credentials use per-item data keys wrapped by `CREDENTIAL_VAULT_KEYS`; ciphertext and injection leases remain outside Data API grants. Message content and memory remain plaintext in Postgres so the assistant can retrieve them; treat database backups as highly sensitive.

To decommission a deployment, remove the Blooio webhook, revoke provider/OAuth credentials, delete Kernel profiles and outstanding artifacts, remove compute-provider secrets, and delete the Supabase project and its backups according to the provider's retention controls.
