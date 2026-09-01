import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { z } from "zod";

export const VM_RUNTIME_ENABLED = false as const;
export const MAX_COMPUTER_ARTIFACT_BYTES = 50 * 1024 * 1024;

export const computerSessionStateSchema = z.enum([
  "provisioning",
  "running",
  "paused",
  "stopped",
  "deleting",
  "deleted",
  "error",
  "unknown",
]);
export type ComputerSessionState = z.infer<typeof computerSessionStateSchema>;

const exactPublicHostnameSchema = z
  .string()
  .min(1)
  .max(253)
  .superRefine((hostname, context) => {
    const labels = hostname.split(".");
    const validLabels = labels.every(
      (label) =>
        label.length >= 1 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    );
    if (
      hostname !== hostname.toLowerCase() ||
      labels.length < 2 ||
      !validLabels ||
      hostname.includes("*") ||
      isIP(hostname) !== 0 ||
      ["local", "localhost", "internal", "home", "lan"].includes(
        labels.at(-1) ?? "",
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "expected a canonical exact public hostname",
      });
    }
  });

function ipv4Number(address: string): bigint {
  return address
    .split(".")
    .reduce((value, octet) => value * 256n + BigInt(octet), 0n);
}

function ipv4Range(cidr: string): readonly [bigint, bigint] | undefined {
  const [address, prefixText, ...extra] = cidr.split("/");
  const prefix = Number(prefixText);
  if (
    extra.length > 0 ||
    !address ||
    isIP(address) !== 4 ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > 32
  ) {
    return undefined;
  }
  const value = ipv4Number(address);
  const size = 1n << BigInt(32 - prefix);
  const start = (value / size) * size;
  if (start !== value) return undefined;
  return [start, start + size - 1n];
}

const prohibitedIpv4Ranges = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
].map((cidr) => ipv4Range(cidr)!);

const publicIpv4CidrSchema = z
  .string()
  .min(9)
  .max(18)
  .superRefine((cidr, context) => {
    const range = ipv4Range(cidr);
    if (
      !range ||
      prohibitedIpv4Ranges.some(
        ([start, end]) => range[0] <= end && range[1] >= start,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "expected a canonical public IPv4 CIDR",
      });
    }
  });

export const computerNetworkPolicySchema = z
  .object({
    mode: z.enum(["block_all", "allowlist"]),
    httpsDomains: z.array(exactPublicHostnameSchema).max(50),
    publicIpv4Cidrs: z.array(publicIpv4CidrSchema).max(50),
  })
  .superRefine((policy, context) => {
    const entries = policy.httpsDomains.length + policy.publicIpv4Cidrs.length;
    if (policy.mode === "block_all" && entries > 0) {
      context.addIssue({
        code: "custom",
        message: "block_all cannot include allowlist entries",
      });
    }
    if (policy.mode === "allowlist" && entries === 0) {
      context.addIssue({
        code: "custom",
        message: "allowlist cannot be empty",
      });
    }
  });
export type ComputerNetworkPolicy = z.infer<typeof computerNetworkPolicySchema>;

export const computerActionSchema = z.union([
  z.object({
    type: z.literal("run_process"),
    executable: z.string().min(1).max(256),
    arguments: z.array(z.string().max(4_096)).max(50),
    workingDirectory: z.string().min(1).max(1_024),
    timeoutSeconds: z.number().int().min(1).max(600),
  }),
  z.object({
    type: z.literal("desktop_input"),
    operation: z.literal("click"),
    x: z.number().int().min(0).max(16_384),
    y: z.number().int().min(0).max(16_384),
  }),
  z.object({
    type: z.literal("desktop_input"),
    operation: z.literal("type_non_secret_text"),
    value: z.string().min(1).max(10_000),
  }),
  z.object({
    type: z.literal("desktop_input"),
    operation: z.literal("press_key"),
    value: z.string().min(1).max(50),
  }),
]);
export type ComputerAction = z.infer<typeof computerActionSchema>;

export const computerOperationOutcomeSchema = z.enum([
  "succeeded",
  "failed_before_effect",
  "unknown",
]);
export type ComputerOperationOutcome = z.infer<
  typeof computerOperationOutcomeSchema
>;

export interface ComputerSession {
  readonly id: string;
  readonly state: ComputerSessionState;
  readonly generation: number;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/**
 * `requestId` is the provider idempotency key. Repeating it must read back the
 * same operation, never invoke the effect again. An `unknown` consequential
 * result is reconciled through `inspectOperationByRequestId` and is not retried.
 */
export const computerProvisionContextSchema = z.object({
  requestId: z.string().uuid(),
  deadlineAt: z.string().datetime(),
  signal: z.instanceof(AbortSignal).optional(),
});
export type ComputerProvisionContext = z.infer<
  typeof computerProvisionContextSchema
>;

export const computerMutationContextSchema =
  computerProvisionContextSchema.extend({
    expectedGeneration: z.number().int().nonnegative(),
  });
export type ComputerMutationContext = z.infer<
  typeof computerMutationContextSchema
>;

export interface ComputerOperationResult<T> {
  readonly requestId: string;
  readonly operationId: string;
  readonly outcome: ComputerOperationOutcome;
  readonly value?: T;
  readonly reason?: string;
}

const artifactNameSchema = z.string().min(1).max(255);
const artifactMimeTypeSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const computerArtifactSchema = z.object({
  id: z.string().min(1).max(255),
  name: artifactNameSchema,
  mimeType: artifactMimeTypeSchema,
  byteLength: z.number().int().min(0).max(MAX_COMPUTER_ARTIFACT_BYTES),
  sha256: sha256Schema,
  sensitivity: z.enum(["internal", "confidential", "secret"]),
  retainUntil: z.string().datetime(),
  createdAt: z.string().datetime(),
});
export type ComputerArtifact = z.infer<typeof computerArtifactSchema>;

export const computerArtifactUploadSchema = z
  .object({
    name: artifactNameSchema,
    mimeType: artifactMimeTypeSchema,
    bytes: z.instanceof(Uint8Array),
    byteLength: z.number().int().min(0).max(MAX_COMPUTER_ARTIFACT_BYTES),
    sha256: sha256Schema,
    sensitivity: z.enum(["internal", "confidential", "secret"]),
    retainUntil: z.string().datetime(),
  })
  .superRefine((artifact, context) => {
    const digest = createHash("sha256").update(artifact.bytes).digest("hex");
    if (
      artifact.bytes.byteLength !== artifact.byteLength ||
      digest !== artifact.sha256
    ) {
      context.addIssue({
        code: "custom",
        message: "artifact failed length or digest verification",
      });
    }
  });
export type ComputerArtifactUpload = z.infer<
  typeof computerArtifactUploadSchema
>;

export const computerArtifactReadSchema = z.object({
  artifactId: z.string().min(1).max(255),
  maxBytes: z.number().int().min(0).max(MAX_COMPUTER_ARTIFACT_BYTES),
});
export type ComputerArtifactRead = z.infer<typeof computerArtifactReadSchema>;

export const computerArtifactDownloadSchema = z
  .object({ metadata: computerArtifactSchema, bytes: z.instanceof(Uint8Array) })
  .superRefine((download, context) => {
    const digest = createHash("sha256").update(download.bytes).digest("hex");
    if (
      download.bytes.byteLength !== download.metadata.byteLength ||
      digest !== download.metadata.sha256
    ) {
      context.addIssue({
        code: "custom",
        message: "downloaded artifact failed length or digest verification",
      });
    }
  });
export type ComputerArtifactDownload = z.infer<
  typeof computerArtifactDownloadSchema
>;

export interface ComputerDeletionEvidence {
  readonly providerResourceId: string;
  readonly deletedGeneration?: number;
  readonly requestedAt: string;
  readonly observedAbsentAt: string;
  readonly evidenceSha256: string;
  readonly tombstoneRetainUntil: string;
  readonly relatedResourcesAbsent: boolean;
}

export interface ComputerSnapshot {
  readonly id: string;
  readonly sourceSessionId: string;
  readonly sourceGeneration: number;
  readonly sha256: string;
  readonly sensitivity: ComputerArtifact["sensitivity"];
  readonly retainUntil: string;
  readonly createdAt: string;
}

export interface ComputerObservation {
  readonly state: ComputerSessionState;
  readonly generation: number;
  readonly capturedAt: string;
  readonly summary: string;
  readonly screenshot?: Uint8Array;
}

export interface ComputerTakeoverCapability {
  readonly url: string;
  readonly expiresAt: string;
}

export interface ComputerCapabilities {
  readonly pauseResume: boolean;
  readonly stopStart: boolean;
  readonly snapshots: boolean;
  readonly desktopInput: boolean;
  readonly processExecution: boolean;
  readonly humanTakeover: boolean;
  readonly dynamicNetworkPolicy: boolean;
  readonly verifiedDeletion: boolean;
  readonly maxArtifactBytes: number;
}

export interface ComputerMeasurements {
  readonly coldStartMilliseconds: number;
  readonly resumeMilliseconds?: number;
  readonly meteredCostUsd: number;
  readonly measuredAt: string;
}

/** Conditional proposal only. There is no production adapter or runtime path. */
export interface ComputerProvider {
  capabilities(): Promise<ComputerCapabilities>;
  provision(
    input: {
      image: string;
      expiresAt: string;
      networkPolicy: ComputerNetworkPolicy;
      correlationId: string;
    },
    context: ComputerProvisionContext,
  ): Promise<ComputerOperationResult<ComputerSession>>;
  findByCorrelationId(
    correlationId: string,
  ): Promise<readonly ComputerSession[]>;
  inspect(sessionId: string): Promise<ComputerSession>;
  inspectOperation(
    operationId: string,
  ): Promise<ComputerOperationResult<unknown>>;
  inspectOperationByRequestId(
    requestId: string,
  ): Promise<ComputerOperationResult<unknown>>;
  measurements(sessionId: string): Promise<ComputerMeasurements>;
  pause(
    sessionId: string,
    context: ComputerMutationContext,
  ): Promise<ComputerOperationResult<ComputerSession>>;
  resume(
    sessionId: string,
    context: ComputerMutationContext,
  ): Promise<ComputerOperationResult<ComputerSession>>;
  stop(
    sessionId: string,
    context: ComputerMutationContext,
  ): Promise<ComputerOperationResult<ComputerSession>>;
  start(
    sessionId: string,
    context: ComputerMutationContext,
  ): Promise<ComputerOperationResult<ComputerSession>>;
  checkpoint(
    sessionId: string,
    context: ComputerMutationContext,
  ): Promise<ComputerOperationResult<ComputerSnapshot>>;
  listSnapshots(sessionId?: string): Promise<readonly ComputerSnapshot[]>;
  inspectSnapshot(snapshotId: string): Promise<ComputerSnapshot>;
  deleteSnapshot(
    snapshotId: string,
    context: ComputerProvisionContext,
  ): Promise<ComputerOperationResult<ComputerDeletionEvidence>>;
  restore(
    snapshotId: string,
    context: ComputerProvisionContext,
  ): Promise<ComputerOperationResult<ComputerSession>>;
  setNetworkPolicy(
    sessionId: string,
    policy: ComputerNetworkPolicy,
    context: ComputerMutationContext,
  ): Promise<ComputerOperationResult<ComputerSession>>;
  observe(sessionId: string): Promise<ComputerObservation>;
  execute(
    sessionId: string,
    action: ComputerAction,
    context: ComputerMutationContext,
  ): Promise<ComputerOperationResult<{ exitCode?: number }>>;
  takeover(
    sessionId: string,
    context: ComputerMutationContext,
  ): Promise<ComputerOperationResult<ComputerTakeoverCapability>>;
  putArtifact(
    sessionId: string,
    input: ComputerArtifactUpload,
    context: ComputerMutationContext,
  ): Promise<ComputerOperationResult<ComputerArtifact>>;
  getArtifact(
    sessionId: string,
    input: ComputerArtifactRead,
    signal?: AbortSignal,
  ): Promise<ComputerArtifactDownload>;
  deleteArtifact(
    sessionId: string,
    artifactId: string,
    context: ComputerMutationContext,
  ): Promise<ComputerOperationResult<ComputerDeletionEvidence>>;
  delete(
    sessionId: string,
    context: ComputerMutationContext,
  ): Promise<ComputerOperationResult<ComputerDeletionEvidence>>;
  decommission(
    sessionId: string,
    context: ComputerMutationContext,
  ): Promise<ComputerOperationResult<ComputerDeletionEvidence>>;
}
