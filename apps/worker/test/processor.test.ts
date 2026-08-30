import { describe, expect, it, vi } from "vitest";
import type { OpenInstinctStore } from "@openinstinct/db";
import type { ServerEnvironment } from "@openinstinct/runtime";
import { JobProcessor } from "../src/processor";
import type { ResolvedLanguageModel } from "../src/models";

const env = {
  NEXT_PUBLIC_APP_URL: "https://assistant.example",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable",
  SUPABASE_SECRET_KEY: "secret",
  DATABASE_URL: "postgresql://postgres:password@db.example.test/postgres",
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  BLOOIO_API_KEY: "blooio",
  BLOOIO_OWNER_PHONE: "+15555550123",
  OWNER_EMAIL: "owner@example.com",
  AI_PROVIDER: "openai",
  AI_MODEL: "test-model",
  OPENAI_API_KEY: "openai",
  INTERNAL_API_SECRET: "a".repeat(32),
} as ServerEnvironment;

describe("durable job processing", () => {
  it("runs a queued owner message, sends once, persists the reply, and completes", async () => {
    const store = {
      getRunContext: vi.fn(async () => ({
        runId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        conversationId: "33333333-3333-4333-8333-333333333333",
        ownerPhone: "+15555550123",
        messages: [{ role: "user" as const, content: "Hello" }],
      })),
      getConnection: vi.fn(async () => undefined),
      listConnections: vi.fn(async () => []),
      searchMemories: vi.fn(async () => []),
      saveAssistantMessage: vi.fn(async () => undefined),
      completeRun: vi.fn(async () => undefined),
    } as unknown as OpenInstinctStore;
    const messenger = {
      sendMessage: vi.fn(async () => ({
        message_id: "message-1",
        status: "sent",
      })),
    };
    const runAgent = vi.fn(async () => ({
      text: "Hi from OpenInstinct.",
      inputTokens: 4,
      outputTokens: 5,
    }));
    const model = {} as ResolvedLanguageModel;
    const processor = new JobProcessor({
      store,
      env,
      messenger,
      model,
      modelId: "test:test-model",
      runAgent,
    });
    const job = {
      type: "process_event" as const,
      eventId: "event-1",
      runId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
    };

    await processor.process(job);

    expect(runAgent).toHaveBeenCalledOnce();
    expect(messenger.sendMessage).toHaveBeenCalledWith({
      to: "+15555550123",
      text: "Hi from OpenInstinct.",
      channelId: undefined,
      idempotencyKey: `run:${job.runId}:response`,
    });
    expect(store.saveAssistantMessage).toHaveBeenCalledWith({
      workspaceId: job.workspaceId,
      conversationId: "33333333-3333-4333-8333-333333333333",
      content: "Hi from OpenInstinct.",
      providerMessageId: "message-1",
      status: "sent",
    });
    expect(store.completeRun).toHaveBeenCalledWith({
      runId: job.runId,
      inputTokens: 4,
      outputTokens: 5,
      model: "test:test-model",
    });
  });
});
