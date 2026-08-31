import { RunNotClaimableError, type OpenInstinctStore } from "@openinstinct/db";
import { randomUUID } from "node:crypto";
import type { JobProcessor } from "./processor";

export class PermanentJobError extends Error {
  override readonly name = "PermanentJobError";
}

export async function consumeJobs(input: {
  store: OpenInstinctStore;
  processor: JobProcessor;
  limit?: number;
}): Promise<
  readonly {
    messageId: number;
    status: "completed" | "failed";
    error?: string;
    queueLatencyMs: number;
  }[]
> {
  await input.store.dispatchDueSchedules();
  await input.store.enqueueAllPendingContinuations();
  await input.store.expireBrowserExecutionHandoffs();
  await input.store.recoverStaleBrowserExecutions();
  await input.store.expireCredentialInjectionLeases();
  await input.processor.cleanupExpiredBrowserSessions();
  await input.processor.cleanupExpiredArtifacts();
  await input.processor.notifyPendingBrowserHandoffs();
  const jobs = await input.store.claimJobs(input.limit ?? 5);
  const results: {
    messageId: number;
    status: "completed" | "failed";
    error?: string;
    queueLatencyMs: number;
  }[] = [];
  for (const claimed of jobs) {
    const claimToken = randomUUID();
    const queueLatencyMs = Math.max(
      0,
      Date.now() - new Date(claimed.enqueuedAt).getTime(),
    );
    try {
      await input.processor.process(claimed.job, claimToken);
      await input.store.archiveJob(claimed.messageId);
      results.push({
        messageId: claimed.messageId,
        status: "completed",
        queueLatencyMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const staleClaim = error instanceof RunNotClaimableError;
      if ("runId" in claimed.job && !staleClaim)
        await input.store.failRun(claimed.job.runId, message, claimToken);
      if (staleClaim && error.retryable)
        await input.store.retryJob(claimed.messageId, error.retryAfterSeconds);
      else if (
        claimed.job.type === "browser_slice" ||
        claimed.job.type === "browser_cleanup"
      ) {
        const delay = Math.min(300, 2 ** Math.min(claimed.readCount, 8));
        await input.store.retryJob(claimed.messageId, delay);
      } else if (
        staleClaim ||
        error instanceof PermanentJobError ||
        claimed.readCount >= 5
      )
        await input.store.archiveJob(claimed.messageId);
      else {
        const delay = Math.min(300, 2 ** Math.min(claimed.readCount, 8));
        await input.store.retryJob(claimed.messageId, delay);
      }
      results.push({
        messageId: claimed.messageId,
        status: "failed",
        error: message,
        queueLatencyMs,
      });
    }
  }
  return results;
}
