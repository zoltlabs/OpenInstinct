# VM decision spike

Decision date: 2026-08-31
Status: **No build**

OpenInstinct will retain a provider-neutral `ComputerProvider` proposal but will
not ship, configure, or operate a VM provider. The build gate fails because two
high-value recurring owner workflows have not been demonstrated, browser and API
alternatives have not failed live acceptance tests, and no real provider has
demonstrated the complete security-control set.

The requested 2–3 week live spike was stopped at this demand preflight. The three
rows below are candidate acceptance definitions, not three real owner workflows.
Running provider resources or presenting synthetic fixtures as real evidence
would not repair that missing product evidence. Daytona, Modal, and self-hosted
Firecracker therefore received documentation-level feasibility review only; the
full test matrix remains intentionally unevaluated.

Documentation establishes candidates for a future live spike; it does not count
as demonstration. A synthetic contract test can validate code semantics but also
does not count as provider evidence.

## Workflow acceptance matrix

| Candidate workflow                      | Why a browser is insufficient                                                             | API alternative                                          | Demand evidence                      | Result                       |
| --------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------ | ---------------------------- |
| Native desktop document edit and export | Requires a non-web GUI and OS-native file dialogs                                         | Product-specific APIs may exist and must be tested first | No recurring owner workflow recorded | Not tested; does not qualify |
| Persistent native toolchain job         | Requires installing binaries and resuming a local filesystem/process context              | A hosted build or typed transformation API may be safer  | No recurring owner workflow recorded | Not tested; does not qualify |
| Large local artifact transformation     | Requires bounded local process and filesystem access beyond the browser transfer contract | Purpose-built conversion APIs may satisfy it             | No recurring owner workflow recorded | Not tested; does not qualify |

These are acceptance-test definitions, not claims that a VM is needed. A future
test must use a real owner-requested workflow, a non-secret test account and
fixture, a deterministic expected artifact, and measurements for duration,
failure mode, cost, and deletion.

## Provider feasibility matrix

Evidence levels are `not_tested`, `documented`, `demonstrated`, and `failed`.
Only a live test with provider-side verification may use `demonstrated`.

| Capability                         | Daytona managed VM                                                                | Modal sandbox/snapshot                                                            | Self-hosted Firecracker                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Persistence and snapshots          | Pause/resume, stop, and snapshots documented; not demonstrated                    | Filesystem snapshots documented; memory snapshots are alpha with seven-day expiry | Architecture documented; OpenInstinct storage/snapshots not designed or tested |
| Pause/resume                       | Documented; not demonstrated                                                      | Snapshot/restore is not equivalent to secure pause/resume                         | Not tested                                                                     |
| Verified deletion/decommissioning  | API can wait for `destroyed`; absence not demonstrated                            | Termination and snapshot retention documented; absence not demonstrated           | Entire lifecycle would be operator-owned; not tested                           |
| Outbound network policy            | Allowlists/block-all documented; custom policies depend on tier                   | CIDR/domain allowlists and block-all documented                                   | Requires host networking policy; not tested                                    |
| GUI/process control and takeover   | Process/SSH documented; no reviewed owner-safe desktop takeover demonstrated      | Process/tunnel documented; no owner-safe desktop takeover demonstrated            | Requires guest agent, display stack, and authenticated relay; not tested       |
| Artifacts and credential isolation | Filesystem/snapshots/volumes documented; retention and isolation not demonstrated | Filesystem/snapshots documented; retention and isolation not demonstrated         | Not designed or tested                                                         |
| Provider failure and cold start    | Not measured                                                                      | Not measured                                                                      | Not measured                                                                   |
| Cost                               | Published rates estimated below; not measured                                     | Published rates estimated below; not measured                                     | Host, storage, operations, and egress cost not estimated                       |
| Result                             | Does not pass                                                                     | Does not pass                                                                     | Does not pass                                                                  |

Provider facts were checked against official documentation on the decision date:

- Daytona persistence and lifecycle: <https://www.daytona.io/docs/en/persistence/>
- Daytona network controls: <https://www.daytona.io/docs/en/network-limits/>
- Daytona TypeScript lifecycle, filesystem, SSH, and deletion API: <https://www.daytona.io/docs/en/typescript-sdk/sandbox/>
- Daytona billing: <https://www.daytona.io/docs/en/billing/>
- Modal snapshot semantics: <https://modal.com/docs/guide/sandbox-snapshots>
- Modal network controls: <https://modal.com/docs/guide/sandbox-networking>
- Modal sandbox SDK: <https://modal.com/docs/sdk/js/latest/Sandbox>
- Modal pricing: <https://modal.com/pricing>
- Firecracker design and security model: <https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md>

## Cost envelope

The provisional owner-visible ceiling is **$25 per owner per month** for the
pilot. This is a gate input, not an approved budget.

- Daytona example: 2 vCPU, 4 GiB RAM, 20 GiB disk, active 40 hours/month and
  retained for 730 hours is approximately **$8.20/month** on the published Linux
  resource rates. Windows licensing would add approximately **$6.86/month**.
- Modal example: 1 physical CPU core, 2 GiB RAM for 40 hours plus a 20 GiB volume
  is approximately **$9.40/month** at published sandbox and volume rates.

The estimates exclude network, regional multipliers, snapshots, taxes, support,
and takeover-specific infrastructure. A live pilot must surface actual metered
spend in the control plane and enforce a hard owner-configured ceiling.

## Contract and safety boundary

`packages/computer` proposes bounded, idempotent lifecycle, snapshot, network,
observation, action, takeover, artifact, measurement, reconciliation, and
verified-deletion methods. Mutations carry durable request IDs, deadlines, and
generation fences; ambiguous provider results are explicitly `unknown` and must
be reconciled by operation or correlation lookup. Artifact writes bind size,
digest, sensitivity, and retention, while deletion returns independently stored
absence evidence. The package intentionally contains no provider SDK or adapter,
and `VM_RUNTIME_ENABLED` remains hard-disabled. Provider references and expiring
takeover capabilities must remain server-side; artifact bytes must move into the
durable artifact store with hashes, sensitivity, retention, and deletion evidence.
The current shape validator cannot trust caller-asserted evidence IDs:
`TRUSTED_VM_EVIDENCE_RESOLVER_ENABLED` is also hard-disabled, so even structurally
complete claims cannot produce a build decision. Reopening requires a durable
repository that binds each fresh evidence record to its workspace, workflow or
provider/control, test version, reviewer, and explicit decision without reuse.

The future live matrix must cover pause/resume, filesystem persistence,
snapshots, verified deletion, GUI/process control, owner takeover, outbound
network policy, metered cost, cold-start latency, artifact handling, credential
isolation, provider-failure ambiguity, and complete decommissioning.

Reopening the build requires all of the following:

1. Two owner-requested, high-value recurring workflows pass VM acceptance tests
   and fail both browser and API alternatives with recorded evidence.
2. One real provider demonstrates pause/resume, verified deletion, restrictive
   networking, short-lived owner takeover, and bounded artifact export/deletion.
3. Failure injection proves provider timeouts become `unknown` and never replay a
   consequential effect automatically.
4. Actual projected monthly cost is visible to the owner and below their explicit
   ceiling.
5. A security review approves custody, encryption, retention, decommissioning,
   and incident-response procedures.

Until then, capability routing stops at the authenticated cloud browser.
