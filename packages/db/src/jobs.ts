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
  }),
  z.object({
    type: z.literal("dispatch_schedules"),
    requestedAt: z.string().datetime(),
  }),
]);

export type AgentJob = z.infer<typeof agentJobSchema>;

export interface ClaimedJob {
  readonly messageId: number;
  readonly readCount: number;
  readonly job: AgentJob;
}
