import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { OpenInstinctStore } from "@openinstinct/db";
import { readServerEnvironment } from "@openinstinct/runtime";
import { JobProcessor } from "./processor";
import { consumeJobs } from "./consumer";

const env = readServerEnvironment();
const store = new OpenInstinctStore(env.DATABASE_URL);
const processor = new JobProcessor({ store, env });
const port = Number(process.env.PORT ?? 3001);
const workerId = randomUUID();
let stopping = false;
let pollTimer: NodeJS.Timeout | undefined;
let lastPollAt: string | undefined;
let lastQueueLatencyMs = 0;

async function pollContinuously(): Promise<void> {
  if (stopping) return;
  try {
    const results = await consumeJobs({ store, processor });
    lastPollAt = new Date().toISOString();
    lastQueueLatencyMs = Math.max(
      0,
      ...results.map((result) => result.queueLatencyMs),
    );
    await store.recordWorkerHeartbeat({
      workerId,
      jobsProcessed: results.length,
      oldestQueueLatencyMs: lastQueueLatencyMs,
    });
  } catch (error) {
    process.stderr.write(
      `Worker poll failed: ${error instanceof Error ? error.message : "unknown"}\n`,
    );
  } finally {
    if (!stopping)
      pollTimer = setTimeout(
        () => void pollContinuously(),
        env.WORKER_POLL_INTERVAL_MS,
      );
  }
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      const database = await store.health();
      response.writeHead(database ? 200 : 503, {
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify({
          ok: database,
          service: "openinstinct-worker",
          mode: env.WORKER_MODE,
          lastPollAt,
          lastQueueLatencyMs,
          interactiveLatencyBudgetMs: env.INTERACTIVE_MAX_QUEUE_LATENCY_MS,
        }),
      );
      return;
    }
    if (request.method === "POST" && request.url === "/internal/consume") {
      if (
        request.headers.authorization !== `Bearer ${env.INTERNAL_API_SECRET}`
      ) {
        response.writeHead(401).end();
        return;
      }
      const results = await consumeJobs({ store, processor });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ processed: results.length, results }));
      return;
    }
    response.writeHead(404).end();
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: error instanceof Error ? error.message : "unknown",
      }),
    );
  }
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`OpenInstinct worker listening on ${port}\n`);
  if (env.WORKER_MODE === "continuous") void pollContinuously();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
    if (pollTimer) clearTimeout(pollTimer);
    server.close(() => void store.close().finally(() => process.exit(0)));
  });
}
