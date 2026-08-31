import { z } from "zod";
import type { RunStatus } from "./domain";

export const runStateSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  conversationId: z.string().uuid().optional(),
  status: z.enum([
    "queued",
    "running",
    "waiting_approval",
    "waiting_event",
    "completed",
    "failed",
    "cancelled",
  ]),
  waitingFor: z.string().optional(),
  attempt: z.number().int().nonnegative(),
  lastError: z.string().optional(),
});

export type RunState = z.infer<typeof runStateSchema>;

const transitions: Record<RunStatus, readonly RunStatus[]> = {
  queued: ["running", "cancelled"],
  running: [
    "queued",
    "waiting_approval",
    "waiting_event",
    "completed",
    "failed",
    "cancelled",
  ],
  waiting_approval: ["queued", "cancelled", "failed"],
  waiting_event: ["queued", "cancelled", "failed"],
  completed: [],
  failed: ["queued", "running", "cancelled"],
  cancelled: [],
};

export function transitionRun(
  state: RunState,
  status: RunStatus,
  options: { waitingFor?: string; error?: string } = {},
): RunState {
  if (!transitions[state.status].includes(status)) {
    throw new Error(`Invalid run transition: ${state.status} -> ${status}`);
  }
  return runStateSchema.parse({
    ...state,
    status,
    waitingFor: options.waitingFor,
    lastError: options.error,
    attempt: status === "running" ? state.attempt + 1 : state.attempt,
  });
}
