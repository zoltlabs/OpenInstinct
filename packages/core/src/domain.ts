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

export type NormalizedEvent = z.infer<typeof normalizedEventSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type ActionRisk = z.infer<typeof actionRiskSchema>;
export type ActionRequest = z.infer<typeof actionRequestSchema>;

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function payloadHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
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
  return actionRequestSchema.parse({
    id: randomUUID(),
    workspaceId: input.workspaceId,
    runId: input.runId,
    toolName: input.toolName,
    risk: input.risk,
    summary: input.summary,
    input: input.payload,
    inputHash: payloadHash(input.payload),
    status: "pending",
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  });
}
