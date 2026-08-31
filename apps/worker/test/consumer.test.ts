import { describe, expect, it, vi } from "vitest";
import { RunNotClaimableError, type OpenInstinctStore } from "@openinstinct/db";
import type { JobProcessor } from "../src/processor";
import { consumeJobs } from "../src/consumer";

describe("queue consumption", () => {
  it("retries a transient failure without archiving the job", async () => {
    const job = {
      type: "process_event" as const,
      eventId: "event-1",
      runId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
    };
    const store = {
      dispatchDueSchedules: vi.fn(async () => 0),
      claimJobs: vi.fn(async () => [{ messageId: 7, readCount: 1, job }]),
      failRun: vi.fn(async () => undefined),
      retryJob: vi.fn(async () => undefined),
      archiveJob: vi.fn(async () => undefined),
    } as unknown as OpenInstinctStore;
    const processor = {
      cleanupExpiredBrowserSessions: vi.fn(async () => undefined),
      process: vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
    } as unknown as JobProcessor;

    await expect(consumeJobs({ store, processor })).resolves.toEqual([
      { messageId: 7, status: "failed", error: "provider unavailable" },
    ]);
    expect(store.failRun).toHaveBeenCalledWith(
      job.runId,
      "provider unavailable",
      expect.any(String),
    );
    expect(store.retryJob).toHaveBeenCalledWith(7, 2);
    expect(store.archiveJob).not.toHaveBeenCalled();
  });

  it("keeps an actively leased durable job available past the normal retry cap", async () => {
    const job = {
      type: "continue_run" as const,
      runId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      toolResultId: "33333333-3333-4333-8333-333333333333",
    };
    const store = {
      dispatchDueSchedules: vi.fn(async () => 0),
      claimJobs: vi.fn(async () => [{ messageId: 8, readCount: 9, job }]),
      failRun: vi.fn(async () => undefined),
      retryJob: vi.fn(async () => undefined),
      archiveJob: vi.fn(async () => undefined),
    } as unknown as OpenInstinctStore;
    const processor = {
      cleanupExpiredBrowserSessions: vi.fn(async () => undefined),
      process: vi.fn(async () => {
        throw new RunNotClaimableError("actively leased", true, 30);
      }),
    } as unknown as JobProcessor;

    await consumeJobs({ store, processor });

    expect(store.retryJob).toHaveBeenCalledWith(8, 30);
    expect(store.archiveJob).not.toHaveBeenCalled();
    expect(store.failRun).not.toHaveBeenCalled();
  });
});
