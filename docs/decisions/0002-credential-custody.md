# ADR 0002: Internal credential vault with model-blind injection

Status: accepted and implemented
Date: 2026-08-31

## Context

At the time of this decision, OpenInstinct stored encrypted OAuth and MCP credentials and could attach externally managed browser profiles, but did not yet have website credential items, password lifecycle, origin binding, access audit, or secure browser injection. The current implementation now follows the decision below.

The product requires a clear source of truth for each credential class. Requiring 1Password, Bitwarden, or Kernel Managed Auth would add accounts and provider dependencies, make deployment behavior inconsistent, and weaken the owner-controlled open-source model. Conversely, letting a high-agency model see plaintext passwords would create exfiltration paths through remote content, tool arguments, logs, errors, screenshots, and replays.

## Decision

OpenInstinct will own the website credential vault.

1. OAuth and connector tokens remain encrypted in `connections.encrypted_credentials`.
2. Website usernames and passwords are encrypted in a new private credential store in Supabase.
3. Kernel profiles store browser cookies and session state, not the password source of truth.
4. A trusted worker decrypts a selected credential only long enough to inject it into an exact-origin browser session.
5. The model can select credential metadata but can never retrieve or type plaintext secrets.
6. Passwords, CAPTCHA, passkeys, OTPs, recovery flows, and unexpected security challenges can always fall back to owner takeover.
7. External password managers and Kernel Managed Auth are optional post-MVP adapters, not dependencies or launch requirements.

This is an assistant credential vault, not a general password-manager replacement. It does not initially provide cross-device sync, browser extensions, password generation, breach monitoring, family sharing, or unattended account recovery.

## Source of truth by credential class

| Credential class                     | Source of truth                                                    |
| ------------------------------------ | ------------------------------------------------------------------ |
| OAuth/API tokens                     | Encrypted OpenInstinct connector record                            |
| Website username/password            | Encrypted OpenInstinct credential vault                            |
| Browser cookies/local storage        | Workspace-bound Kernel profile                                     |
| OTP, passkey, recovery code, CAPTCHA | Owner takeover initially                                           |
| Payment secret                       | Owner takeover, browser wallet, or provider tokenization initially |

Browser cookies and local storage are themselves authentication secrets. Kernel is therefore a trusted secret-bearing execution processor even though it is not the password custodian. Profile access, use, revocation, retention, and deletion require the same audit rigor as credential-item access.

## Storage design

### Owner-visible metadata

Create `public.credential_items` with:

- ID and workspace ID;
- credential kind;
- display label and non-secret username hint;
- exact allowed origins;
- status and last verification time;
- rotation due time;
- configuration version;
- encryption-key version;
- created, updated, and revoked timestamps.

Authenticated browser roles may receive an explicitly safe view of this metadata. They never receive ciphertext, wrapped keys, full usernames unless deliberately classified as safe, or provider capability identifiers.

### Private ciphertext

Create `app_private.credential_secrets` with:

- credential item ID and workspace ID;
- ciphertext envelope version;
- wrapped per-item data-encryption key;
- nonce, authentication tag, and ciphertext;
- cryptographic metadata required for rotation;
- created and re-encrypted timestamps.

The table receives no Data API grants. Only narrowly scoped server-side `packages/db` methods using a direct Postgres connection may access it. Trusted owner-control routes use those methods for add, replace, freshly reauthenticated reveal/export, revoke, and delete; the worker uses them for validated injection. Supabase browser clients can never access it.

The encrypted payload contains the full username and password. Associated data binds:

- workspace ID;
- credential item ID;
- credential kind;
- canonical exact allowed origins;
- record and configuration versions.

Each item uses a random data-encryption key. A dedicated versioned credential-vault wrapping key or managed KMS key-encryption key wraps the item key; it is separate from the connector `SECRET_ENCRYPTION_KEY`. The data-encryption key exists in worker memory only during encryption or injection and is never persisted unwrapped.

For simple self-hosted deployments, the wrapping key may begin as a versioned server-only environment secret. Managed KMS wrapping is optional, but the envelope format and rotation workflow are mandatory before password-vault launch.

## Broker boundary

Create `packages/credentials` containing provider-neutral schemas, origin validation, injection orchestration, and secret-redaction helpers. SQL and encryption-at-rest repositories remain owned by `packages/db`.

The broker exposes metadata and purpose-built operations, never an unrestricted model-visible `getSecret`:

```text
listMetadata(workspace, filters)
validateUse(item, origin, executionProfile, approvedContext)
inject(item, executionSession, classifiedTargetField, approvedContext)
checkHealth(item)
replace(item, ownerSuppliedSecret)
revoke(item)
```

Plaintext resolution occurs inside a narrow trusted-worker callback. The value is kept in memory only for the minimum duration, cannot be serialized by public types, and is passed directly to the browser executor with screenshots and replay capture disabled around injection.

JavaScript runtimes and remote browser SDKs cannot promise cryptographic zeroization of every temporary copy. The implementation must prefer buffers over immutable strings where APIs allow, overwrite buffers best-effort, isolate injection in a short-lived executor process where practical, disable core dumps/heap snapshots and secret-bearing tracing, and treat the worker host and Kernel transport as trusted secret processors. This residual risk must be documented rather than hidden behind an “immediate discard” claim.

## Origin and field binding

Credential use requires all of:

- exact HTTPS origin match, with separately approved subdomain rules;
- active workspace-bound execution profile and exclusive session lease;
- credential item, browser profile, and policy configuration versions matching approval;
- target field classified as a credential field by trusted executor logic;
- current action policy permitting the credential-use class;
- no cross-origin iframe unless explicitly modeled and separately origin-bound;
- audit event before and after injection.

Redirects, lookalike domains, changed SSO issuers, ambiguous frames, stale profiles, and origin changes fail closed or require human takeover.

## Owner control plane

The authenticated owner can:

- add a credential through a secret-safe form;
- replace it without redisplaying the existing value;
- test login health;
- revoke and delete it;
- invalidate associated browser profiles;
- view metadata-only access history;
- reveal or export only after fresh owner reauthentication and an explicit high-risk confirmation.

Reveals and exports are unavailable through iMessage. The emergency export is encrypted to owner-supplied key material or another reviewed recovery mechanism; it never downloads a plaintext vault by default.

If the deployment wrapping key is lost and no recovery wrapping key exists, the system fails closed and credentials must be re-entered. OpenInstinct must never weaken encryption or retain a hidden recovery key to avoid this outcome.

## OTP, TOTP, passkeys, recovery, and payments

These remain separate capability classes:

- Email or SMS OTP: initially trigger owner takeover. Gmail and messaging connectors must redact likely OTP, password-reset, recovery-code, and security-challenge messages before model context.
- TOTP: do not store seeds until envelope encryption, access audit, replay suppression, rotation, and a dedicated security review are complete.
- Passkeys and hardware-backed credentials: use owner takeover or a platform-supported delegated flow; never extract key material.
- Recovery codes and security answers: owner takeover only.
- Payment instruments: store aliases and policy metadata only. Use a browser wallet, provider tokenization, or owner takeover until the financial program approves another design.

## Audit and revocation

`credential_access_events` is append-only and records item ID, workspace, exact origin, execution profile/session, run/action, reason, decision, result, and timestamp. It cannot contain plaintext, entered field content, wrapped/unwrapped keys, raw DOM, screenshot pixels, or provider live-view tokens.

Revocation must:

1. prevent future decryption and injection;
2. invalidate active execution leases using the item;
3. mark associated browser profiles for deletion or reauthentication;
4. verify provider-side session/profile deletion where requested;
5. emit a complete audit chain.

## Rejected defaults

### Store passwords in `connections.encrypted_credentials`

Rejected because connector tokens and website credentials have different lifecycle, origin, injection, audit, reveal, rotation, and revocation requirements.

### Let the model type secrets

Rejected because model context, tool payloads, traces, errors, screenshots, replays, and indirect prompt injection become disclosure paths.

### Require 1Password or Bitwarden

Rejected as the default because it adds an external account and makes a core capability conditional on a third-party vault. Future adapters may import or reference credentials for owners who explicitly opt in.

### Use Kernel Managed Auth as the password store

Rejected as the default because it makes the browser provider the password custodian and increases provider lock-in. Kernel remains responsible for browser sessions and necessarily processes a credential during injection.

### Rely only on browser cookies

Rejected because sessions expire, reauthentication recurs, and owner-controlled credential rotation and revocation still need a durable source of truth.

## Rollout order

1. Human login into a persistent profile, without stored password.
2. Private ciphertext schema, metadata, access audit, and envelope-key rotation.
3. Owner add/replace/revoke/delete UX.
4. Exact-origin model-blind injection with replay and screenshot suppression.
5. Freshly reauthenticated reveal and encrypted emergency export.
6. OTP filtering and human handoff.
7. TOTP only after dedicated security review.
8. Payment credential handling only through the financial-action program.
9. Optional external-vault or managed-auth adapters after the internal vault passes launch gates.

## Acceptance criteria

- Secret canaries never appear in model messages, action payloads, logs, errors, audit details, screenshots, replays, or client responses.
- Wrong-origin, changed-origin, stale-profile, stale-credential, iframe, and cross-workspace attempts fail closed.
- Revocation prevents use immediately and invalidates related session state.
- Every credential access has a complete metadata-only audit chain.
- Key rotation is crash-safe and does not require plaintext export.
- The owner can add, replace, test, revoke, delete, and perform a freshly reauthenticated encrypted emergency export.
- Losing the wrapping key has a documented fail-closed outcome.
- Provider and database deletion are both verified during decommissioning.
