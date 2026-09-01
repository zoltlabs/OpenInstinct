import { describe, expect, it } from "vitest";
import {
  computerActionSchema,
  computerArtifactDownloadSchema,
  computerArtifactUploadSchema,
  computerMutationContextSchema,
  computerNetworkPolicySchema,
  evaluateVmBuildGate,
  evidenceClaimSchema,
  VM_RUNTIME_ENABLED,
  type EvidenceClaim,
  type VmBuildGateInput,
} from "../src/index";

let evidenceCounter = 1;
function liveEvidence(): EvidenceClaim {
  const suffix = String(evidenceCounter++).padStart(12, "0");
  return {
    level: "demonstrated",
    source: "live_provider",
    evidenceId: `00000000-0000-4000-8000-${suffix}`,
    reviewId: `10000000-0000-4000-8000-${suffix}`,
    recordedAt: "2026-08-31T12:00:00.000Z",
  };
}

function controls() {
  return {
    pauseResume: liveEvidence(),
    filesystemPersistence: liveEvidence(),
    snapshots: liveEvidence(),
    deletion: liveEvidence(),
    guiAndProcessControl: liveEvidence(),
    networkPolicy: liveEvidence(),
    takeover: liveEvidence(),
    artifactHandling: liveEvidence(),
    credentialIsolation: liveEvidence(),
    decommissioning: liveEvidence(),
  };
}

function completeInput(): VmBuildGateInput {
  const workflow = (id: string, highValueRecurring = true) => ({
    id,
    name: id,
    highValueRecurring,
    vmRequired: true,
    browserAcceptance: "failed" as const,
    apiAcceptance: "failed" as const,
    evidence: liveEvidence(),
    note: "Durable reviewed acceptance evidence.",
  });
  const provider = (
    name: string,
    category:
      | "managed_persistent_vm"
      | "sandbox_snapshot"
      | "self_hosted_microvm",
  ) => ({
    provider: name,
    category,
    controls: controls(),
    failureInjection: liveEvidence(),
    projectedMonthlyCostUsd: 12,
    costVisibleToOwner: true,
    costEvidence: liveEvidence(),
    note: "Durable reviewed provider evidence.",
  });
  return {
    ownerMonthlyCostLimitUsd: 25,
    securityReview: { decision: "approved", evidence: liveEvidence() },
    workflows: [
      workflow("native-app"),
      workflow("toolchain"),
      workflow("artifact", false),
    ],
    providers: [
      provider("persistent", "managed_persistent_vm"),
      provider("snapshot", "sandbox_snapshot"),
      provider("microvm", "self_hosted_microvm"),
    ],
  };
}

describe("VM build gate", () => {
  it("rejects synthetic claims of demonstrated evidence", () => {
    expect(
      evidenceClaimSchema.safeParse({
        level: "demonstrated",
        source: "synthetic",
      }).success,
    ).toBe(false);
    expect(VM_RUNTIME_ENABLED).toBe(false);
  });

  it("recognizes complete evidence but keeps runtime hard-disabled", () => {
    const result = evaluateVmBuildGate(completeInput());
    expect(result.build).toBe(false);
    expect(result.checks.trustedEvidenceResolved).toBe(false);
    expect(result.checks.runtimeReleaseEnabled).toBe(false);
    expect(result.eligibleProviders).toEqual([
      "persistent",
      "snapshot",
      "microvm",
    ]);
  });

  it.each([
    [
      "workflow demand",
      (input: VmBuildGateInput) =>
        (input.workflows[1]!.highValueRecurring = false),
    ],
    [
      "alternative failure",
      (input: VmBuildGateInput) =>
        (input.workflows[0]!.apiAcceptance = "passed"),
    ],
    [
      "same-provider cost",
      (input: VmBuildGateInput) =>
        input.providers.forEach(
          (provider) => (provider.projectedMonthlyCostUsd = 30),
        ),
    ],
    [
      "failure injection",
      (input: VmBuildGateInput) =>
        input.providers.forEach(
          (provider) =>
            (provider.failureInjection = {
              level: "not_tested",
              source: "none",
            }),
        ),
    ],
    [
      "security approval",
      (input: VmBuildGateInput) =>
        (input.securityReview = {
          decision: "rejected",
          evidence: { level: "not_tested", source: "none" },
        }),
    ],
  ])("fails when %s is absent", (_name, mutate) => {
    const input = completeInput();
    mutate(input);
    expect(evaluateVmBuildGate(input).build).toBe(false);
  });

  it("rejects duplicate workflow evidence", () => {
    const input = completeInput();
    input.workflows[1]!.id = input.workflows[0]!.id;
    expect(() => evaluateVmBuildGate(input)).toThrow(/unique/u);
  });

  it("bounds actions and rejects ambiguous desktop input", () => {
    expect(
      computerActionSchema.safeParse({
        type: "desktop_input",
        operation: "click",
        x: 100,
        y: 200,
      }).success,
    ).toBe(true);
    expect(
      computerActionSchema.safeParse({
        type: "desktop_input",
        operation: "click",
      }).success,
    ).toBe(false);
    expect(
      computerActionSchema.safeParse({
        type: "desktop_input",
        operation: "type_non_secret_text",
      }).success,
    ).toBe(false);
  });

  it.each([
    "0.0.0.0/0",
    "10.0.0.0/8",
    "127.0.0.1/32",
    "169.254.169.254/32",
    "192.168.0.0/16",
    "203.0.113.0/24",
  ])("rejects unsafe CIDR %s", (cidr) => {
    expect(
      computerNetworkPolicySchema.safeParse({
        mode: "allowlist",
        httpsDomains: [],
        publicIpv4Cidrs: [cidr],
      }).success,
    ).toBe(false);
  });

  it("accepts exact public hosts and canonical public IPv4 ranges", () => {
    expect(
      computerNetworkPolicySchema.safeParse({
        mode: "allowlist",
        httpsDomains: ["api.example.com"],
        publicIpv4Cidrs: ["8.8.8.0/24"],
      }).success,
    ).toBe(true);
    for (const hostname of [
      "*.example.com",
      "https://example.com",
      "LOCALHOST",
      "host.local",
    ]) {
      expect(
        computerNetworkPolicySchema.safeParse({
          mode: "allowlist",
          httpsDomains: [hostname],
          publicIpv4Cidrs: [],
        }).success,
      ).toBe(false);
    }
  });

  it("requires generation fencing and verifies artifact bytes", () => {
    expect(
      computerMutationContextSchema.safeParse({
        requestId: "00000000-0000-4000-8000-000000000001",
        deadlineAt: "2026-08-31T12:00:00.000Z",
      }).success,
    ).toBe(false);

    const bytes = new Uint8Array();
    const sha256 =
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const upload = {
      name: "empty.txt",
      mimeType: "text/plain",
      bytes,
      byteLength: 0,
      sha256,
      sensitivity: "internal" as const,
      retainUntil: "2026-09-01T12:00:00.000Z",
    };
    expect(computerArtifactUploadSchema.safeParse(upload).success).toBe(true);
    expect(
      computerArtifactUploadSchema.safeParse({ ...upload, byteLength: 1 })
        .success,
    ).toBe(false);
    expect(
      computerArtifactDownloadSchema.safeParse({
        metadata: {
          ...upload,
          id: "artifact-1",
          createdAt: "2026-08-31T12:00:00.000Z",
        },
        bytes: new Uint8Array([1]),
      }).success,
    ).toBe(false);
  });
});
