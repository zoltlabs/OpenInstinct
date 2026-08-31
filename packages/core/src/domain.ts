import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const eventSourceSchema = z.enum([
  "blooio",
  "google",
  "mcp",
  "schedule",
  "system",
]);

export const normalizedEventSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().uuid(),
  source: eventSourceSchema,
  type: z.string().min(1),
  occurredAt: z.string().datetime(),
  conversationId: z.string().uuid().optional(),
  payload: z.record(z.string(), z.unknown()),
});

export const runStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_approval",
  "waiting_event",
  "completed",
  "failed",
  "cancelled",
]);

export const actionRiskSchema = z.enum([
  "read",
  "write",
  "communicate",
  "financial",
  "destructive",
  "security",
]);

export const actionRequestSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  runId: z.string().uuid(),
  toolName: z.string().min(1),
  risk: actionRiskSchema,
  summary: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  inputHash: z.string().length(64),
  status: z.enum([
    "pending",
    "approved",
    "executing",
    "executed",
    "denied",
    "expired",
    "failed",
    "unknown",
  ]),
  expiresAt: z.string().datetime(),
});

export const resultCertaintySchema = z.enum([
  "succeeded",
  "failed_before_effect",
  "failed_after_reversible_effect",
  "unknown",
  "reconciled_succeeded",
  "reconciled_failed",
]);

export const workflowStepStatusSchema = z.enum([
  "planned",
  "waiting_approval",
  "running",
  "succeeded",
  "failed",
  "unknown",
  "cancelled",
]);

export const workflowExecutionPhaseSchema = z.enum([
  "claimed",
  "invocation_started",
  "result_received",
  "result_persisted",
]);

export const runEventTypeSchema = z.enum([
  "run_created",
  "run_started",
  "run_completed",
  "run_failed",
  "run_cancelled",
  "action_proposed",
  "approval_decided",
  "action_execution_claimed",
  "action_invocation_started",
  "action_result_received",
  "action_retry_scheduled",
  "tool_result_recorded",
  "continuation_enqueued",
]);

export const structuredToolResultSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    runId: z.string().uuid(),
    stepId: z.string().uuid(),
    actionRequestId: z.string().uuid().optional(),
    reconcilesResultId: z.string().uuid().optional(),
    toolName: z.string().min(1).max(256),
    certainty: resultCertaintySchema,
    attempt: z.number().int().positive(),
    output: z.unknown().optional(),
    outputHash: z.string().length(64).optional(),
    errorCode: z.string().min(1).max(128).optional(),
    errorMessage: z.string().min(1).max(2_000).optional(),
    retryEligible: z.boolean(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
  })
  .superRefine((result, context) => {
    const isReconciliation = [
      "reconciled_succeeded",
      "reconciled_failed",
    ].includes(result.certainty);
    if (isReconciliation !== Boolean(result.reconcilesResultId))
      context.addIssue({
        code: "custom",
        path: ["reconcilesResultId"],
        message:
          "Reconciled results must reference the unknown result they reconcile.",
      });
    if (result.retryEligible && result.certainty !== "failed_before_effect")
      context.addIssue({
        code: "custom",
        path: ["retryEligible"],
        message: "Only failed_before_effect results may be retry eligible.",
      });
    if (result.output !== undefined) {
      let expected: string | undefined;
      let serialized: string | undefined;
      try {
        expected = payloadHash(result.output);
        serialized = stableJson(result.output);
      } catch {
        context.addIssue({
          code: "custom",
          path: ["output"],
          message: "Tool result output must be canonical JSON.",
        });
      }
      if (expected && result.outputHash !== expected)
        context.addIssue({
          code: "custom",
          path: ["outputHash"],
          message: "Tool result output hash does not match its output.",
        });
      if (serialized && Buffer.byteLength(serialized, "utf8") > 128_000)
        context.addIssue({
          code: "custom",
          path: ["output"],
          message: "Tool result output must not exceed 128 KB.",
        });
    } else if (result.outputHash !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["outputHash"],
        message: "Output hash requires an output value.",
      });
    }
  });

export type NormalizedEvent = z.infer<typeof normalizedEventSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type ActionRisk = z.infer<typeof actionRiskSchema>;
export type ActionRequest = z.infer<typeof actionRequestSchema>;
export type ResultCertainty = z.infer<typeof resultCertaintySchema>;
export type WorkflowStepStatus = z.infer<typeof workflowStepStatusSchema>;
export type WorkflowExecutionPhase = z.infer<
  typeof workflowExecutionPhaseSchema
>;
export type RunEventType = z.infer<typeof runEventTypeSchema>;
export type StructuredToolResult = z.infer<typeof structuredToolResultSchema>;

export type CanonicalJsonValue =
  | null
  | string
  | number
  | boolean
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

export function normalizeJsonValue(value: unknown): CanonicalJsonValue {
  const active = new WeakSet<object>();
  const visit = (entry: unknown): CanonicalJsonValue => {
    if (
      entry === null ||
      typeof entry === "string" ||
      typeof entry === "boolean"
    )
      return entry;
    if (typeof entry === "number") {
      if (!Number.isFinite(entry))
        throw new Error("JSON numbers must be finite.");
      return entry;
    }
    if (!entry || typeof entry !== "object")
      throw new Error("Value is not JSON serializable.");
    if (active.has(entry)) throw new Error("JSON values cannot be cyclic.");
    active.add(entry);
    try {
      if (Array.isArray(entry)) return entry.map(visit);
      const prototype = Object.getPrototypeOf(entry);
      if (prototype !== Object.prototype && prototype !== null)
        throw new Error("JSON objects must be plain objects.");
      return Object.fromEntries(
        Object.entries(entry).map(([key, item]) => [key, visit(item)]),
      );
    } finally {
      active.delete(entry);
    }
  };
  return visit(value);
}

function stableNormalizedJson(value: CanonicalJsonValue): string {
  if (Array.isArray(value))
    return `[${value.map(stableNormalizedJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, entry]) =>
          `${JSON.stringify(key)}:${stableNormalizedJson(entry)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function stableJson(value: unknown): string {
  return stableNormalizedJson(normalizeJsonValue(value));
}

export function payloadHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function isResultRetryable(certainty: ResultCertainty): boolean {
  return certainty === "failed_before_effect";
}

export function createActionRequest(input: {
  workspaceId: string;
  runId: string;
  toolName: string;
  risk: ActionRisk;
  summary: string;
  payload: Record<string, unknown>;
  expiresInMs?: number;
}): ActionRequest {
  const expiresInMs = input.expiresInMs ?? 24 * 60 * 60 * 1000;
  const payload = normalizeJsonValue(input.payload);
  if (!payload || Array.isArray(payload) || typeof payload !== "object")
    throw new Error("Action payload must be a JSON object.");
  return actionRequestSchema.parse({
    id: randomUUID(),
    workspaceId: input.workspaceId,
    runId: input.runId,
    toolName: input.toolName,
    risk: input.risk,
    summary: input.summary,
    input: payload,
    inputHash: payloadHash(payload),
    status: "pending",
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  });
}
