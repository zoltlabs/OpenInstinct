import { RunNotClaimableError, type OpenInstinctStore } from "@openinstinct/db";
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
  }[]
> {
  await input.store.dispatchDueSchedules();
  const jobs = await input.store.claimJobs(input.limit ?? 5);
  const results: {
    messageId: number;
    status: "completed" | "failed";
    error?: string;
  }[] = [];
  for (const claimed of jobs) {
    try {
      await input.processor.process(claimed.job);
      await input.store.archiveJob(claimed.messageId);
      results.push({ messageId: claimed.messageId, status: "completed" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const staleClaim = error instanceof RunNotClaimableError;
      if ("runId" in claimed.job && !staleClaim)
        await input.store.failRun(claimed.job.runId, message);
      if (
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
      });
    }
  }
  return results;
}
