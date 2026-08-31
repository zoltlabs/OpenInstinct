import { z } from "zod";

export const agentJobSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("process_event"),
    eventId: z.string(),
    runId: z.string().uuid(),
    workspaceId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("resume_run"),
    runId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    actionId: z.string().uuid().optional(),
  }),
  z.object({
    type: z.literal("continue_run"),
    runId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    toolResultId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("dispatch_schedules"),
    requestedAt: z.string().datetime(),
  }),
  z.object({
    type: z.literal("deliver_reminder"),
    triggerId: z.string().uuid(),
    occurrenceAt: z.string().datetime(),
    workspaceId: z.string().uuid(),
    conversationId: z.string().uuid(),
    message: z.string().min(1).max(4000),
  }),
]);

export type AgentJob = z.infer<typeof agentJobSchema>;

export interface ClaimedJob {
  readonly messageId: number;
  readonly readCount: number;
  readonly job: AgentJob;
}
