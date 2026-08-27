# Security policy

Please report vulnerabilities privately through GitHub Security Advisories. Do not open public issues containing credentials, personal messages, OAuth tokens, webhook payloads, or exploit details.

## Deployment requirements

- Use a dedicated Supabase project and a dedicated Blooio API key.
- Keep `SUPABASE_SECRET_KEY`, `DATABASE_URL`, OAuth client secrets, Blooio secrets, AI keys, and `SECRET_ENCRYPTION_KEY` server-only.
- Use HTTPS for every public callback and webhook.
- Restrict database network access where the host permits it and use SSL remotely.
- Rotate connector credentials and the Blooio API key after suspected exposure. Rotating `SECRET_ENCRYPTION_KEY` requires re-encrypting or reconnecting every connector.
- Configure Supabase Auth redirect allowlists to the exact production origin. `OWNER_EMAIL` is the only address accepted by the app, and browser roles cannot create the owner workspace directly.

## Intentional safety boundaries

Consequential external actions require owner approval. The approval covers an immutable input hash and connector configuration version, not a mutable model continuation. Generic MCP endpoints must be HTTPS, cannot redirect, and use a transport-level DNS check that rejects non-public destinations on every new socket. Apply outbound network policy in production as defense in depth.

When a provider response is ambiguous, OpenInstinct marks the action `unknown`, warns the owner, and never retries automatically. Calendar creates use a deterministic provider event ID; Gmail drafts and arbitrary MCP servers cannot provide a universal exactly-once guarantee.

The Kernel adapter exists but browser writes are not exposed to the model in the initial release. Financial and destructive operations should remain disabled until they have connector-specific policies, limits, and confirmation UX.

## Data handling

OAuth/MCP credentials are encrypted with AES-256-GCM and workspace/connection-bound associated data. Message content and memory remain plaintext in Postgres so the assistant can retrieve them; treat database backups as highly sensitive. Delete the Supabase project and Blooio webhook to fully decommission a deployment.
