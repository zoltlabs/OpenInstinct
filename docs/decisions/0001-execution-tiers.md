# ADR 0001: Browser-first execution with conditional VM and device tiers

Status: accepted and implemented through the browser tier; VM and device tiers deferred
Date: 2026-08-31

## Context

OpenInstinct must operate authenticated websites reliably and may eventually need native desktop or mobile applications. The current Kernel adapter creates a browser session, runs one short Playwright program, and destroys the session. This is not strong computer use, but it does not follow that every owner needs an always-on VM or phone.

The platform must preserve these constraints:

- one owner per deployment;
- Supabase owns durable workflow state;
- compute providers are replaceable;
- credentials never enter model context;
- consequential actions retain exact approval, revalidation, and no-replay-on-ambiguity guarantees;
- provider-specific dependencies stay outside core, database, messaging, and connectors.

## Decision

Adopt explicit execution tiers and route every task to the lowest capable tier.

### Tier 0: connector

Use typed direct APIs first and reviewed MCP second. This remains the preferred path for reliable identifiers, idempotency, structured postconditions, and lower data exposure.

### Tier 1: isolated authenticated browser

Use Kernel as the initial browser adapter behind an expanded provider-neutral contract.

Kernel's documented surface includes browser profiles, live human takeover, computer controls, file I/O, replays, isolated browser VMs, and sessions lasting up to 72 hours. OpenInstinct currently uses only profile attachment and short Playwright execution. Although Kernel also offers managed authentication, this architecture deliberately keeps OpenInstinct's internal vault as the website-password source of truth.

Tier 1 is the default “personal computer” for web tasks. It is on-demand, backed by persistent authentication profiles and durable OpenInstinct checkpoints. It is not an always-running VM.

### Tier 2: persistent desktop VM

Do not provision this tier by default. Add a provider-neutral `ComputerProvider` and select an adapter only after a measured spike proves browser/API insufficiency for at least two high-value recurring workflows.

The spike should evaluate:

- managed persistent Linux or Windows VM with pause/resume and snapshots;
- sandbox/snapshot environment for file and CLI workflows;
- self-hosted microVM only if managed providers cannot satisfy isolation, deletion, or cost requirements.

Daytona is the lead managed VM candidate for the spike because its current documentation describes persistent Linux and Windows VM filesystems, pause/resume with memory, snapshots, forks, and volumes. Modal is a candidate for sandboxed file/CLI workloads, not the assumed GUI desktop winner. Self-hosted Firecracker is the last option because OpenInstinct would inherit host hardening, image maintenance, network isolation, snapshot uniqueness, capacity, and incident response.

### Tier 3: dedicated mobile device

Do not use shared public testing fleets with owner credentials. AWS Device Farm explicitly advises against sensitive login information and records or retains session artifacts.

If mobile-only use cases justify the tier, begin with a dedicated Android emulator or dedicated physical Android device bound to one deployment. iOS is a separate program requiring signing, automation, platform-policy, and operational review.

Telephony should use a typed call provider rather than a device unless a specific workflow truly requires a phone UI.

## Promotion criteria

A task may move up a tier only when all lower tiers fail a documented capability test.

| Promotion            | Required evidence                                                                       |
| -------------------- | --------------------------------------------------------------------------------------- |
| Connector to browser | No suitable API/tool, or rendered UI is essential                                       |
| Browser to VM        | Native desktop, durable filesystem, or a reviewed CLI; never automation-control evasion |
| VM to device         | Workflow exists only in a mobile app or depends on real device hardware/identity        |

## Provider-neutral contracts

### BrowserProvider v2

The contract should cover profile lifecycle, session lifecycle, reconnect, observe, one typed action, file transfer, health, checkpoint, takeover, replay controls, and deletion. Provider capability discovery must be explicit so the worker can fail closed when an adapter lacks a required primitive.

### ComputerProvider

The conditional contract should cover:

- create/start/stop/pause/resume/terminate;
- screenshot and structured observation where possible;
- keyboard, pointer, and typed UI actions;
- bounded process invocation;
- file upload/download with scanning;
- checkpoint/snapshot and restore;
- live human takeover;
- outbound network policy;
- health, cost, lease, and provider-side deletion.

### DeviceProvider

The conditional contract should add tap/swipe, orientation, app lifecycle, notifications, location policy, device identity, reset/decommissioning, and Appium/ADB or equivalent health. SIM, SMS, biometric, attestation, and hardware-backed keys must be declared capabilities rather than assumed.

## Security requirements shared by all tiers

- Each execution profile is bound to the singleton workspace and a configuration version.
- Profile cookies and browser storage are secret-bearing authentication state even though OpenInstinct cannot read them as ordinary vault items.
- Provider session IDs are server-only; live-view tokens are minted on demand and expire quickly.
- Sessions use durable leases so two workers cannot control the same identity concurrently.
- Secret entry occurs through a credential broker or human takeover, never model typing.
- Observations and artifacts are bounded, redacted, hashed, and retention-controlled.
- The executor revalidates origin and semantic commit facts immediately before side effects.
- Ambiguous outcomes are never automatically replayed.
- Provider-side deletion is verified, audited, and included in deployment decommissioning.
- A higher tier is never used merely to circumvent a site's access controls, CAPTCHA, bot restrictions, or terms.

## Consequences

Positive:

- The near-term roadmap uses capabilities already available from the current browser provider.
- Most life-admin web tasks avoid the cost and attack surface of an always-on VM.
- Native desktop and mobile remain possible without contaminating core domain code.
- Provider replacement and capability testing become explicit.

Costs:

- The worker needs a real session/lease/checkpoint orchestration layer.
- Provider contract tests and live canary accounts become mandatory.
- Some popular sites remain unsupported or takeover-only and require honest capability reporting.
- Desktop and mobile workflows will arrive later than browser workflows.

## Revisit triggers

Revisit this decision when:

- two or more high-value workflows repeatedly fail solely because Kernel cannot support the site;
- native desktop work represents a material share of requested goals;
- a managed provider changes retention, credential, live-view, or isolation guarantees;
- mobile-only requests cross the product threshold defined for the device spike;
- per-owner browser cost approaches the projected paused-VM cost.
