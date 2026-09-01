import { describe, expect, it, vi } from "vitest";
import type { OpenInstinctStore } from "@openinstinct/db";
import {
  deriveSemanticGuards,
  payloadHash,
  semanticGuardHash,
  semanticIntentHash,
} from "@openinstinct/core";
import type { ServerEnvironment } from "@openinstinct/runtime";
import { JobProcessor, normalizeToolOutput } from "../src/processor";
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

function memoryAction(status: "executing" | "unknown") {
  const input = {
    kind: "preference",
    content: "Prefers tea",
    sensitivity: "personal",
  };
  const semanticIntent = {
    version: 1 as const,
    effect: "create" as const,
    resource: { class: "memory" },
    provider: "openinstinct",
    exactOrigin: null,
    recipients: [],
    reversibility: "reversible" as const,
    commitPoint: true,
    credentialUse: "none" as const,
    postconditions: [{ subject: "memory.exists", operator: "exists" as const }],
  };
  const guardConditions = deriveSemanticGuards({
    intent: semanticIntent,
    payload: input,
  });
  return {
    id: "44444444-4444-4444-8444-444444444444",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    runId: "11111111-1111-4111-8111-111111111111",
    toolName: "memory.save",
    risk: "write" as const,
    summary: "Remember a preference",
    input,
    inputHash: payloadHash(input),
    semanticIntent,
    semanticIntentHash: semanticIntentHash(semanticIntent),
    guardConditions,
    guardConditionsHash: semanticGuardHash(guardConditions),
    status,
    expiresAt: "2026-09-01T12:00:00.000Z",
  };
}

describe("durable job processing", () => {
  it("retains only a hash and safe metadata for hostile provider output", () => {
    const raw = { cookie: "session=secret", page: "hostile" };
    expect(normalizeToolOutput("browser.run", raw)).toEqual({
      status: "succeeded",
      providerOutputOmitted: true,
      rawOutputHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      reason: "Untrusted provider output is not retained in plaintext.",
    });
    expect(JSON.stringify(normalizeToolOutput("mcp.call", raw))).not.toContain(
      "secret",
    );
  });

  it("runs a queued owner message, sends once, persists the reply, and completes", async () => {
    const store = {
      getVerifiedOwnerPhone: vi.fn(async () => "+15555550123"),
      getRunContext: vi.fn(async () => ({
        runId: "11111111-1111-4111-8111-111111111111",
        claimToken: "99999999-9999-4999-8999-999999999999",
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
      env: { ...env, BLOOIO_OWNER_PHONE: "+15555550999" },
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

    expect(store.getRunContext).toHaveBeenCalledWith(
      job.runId,
      expect.any(String),
      { type: "process_event", workspaceId: job.workspaceId },
    );
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
      claimToken: "99999999-9999-4999-8999-999999999999",
      inputTokens: 4,
      outputTokens: 5,
      model: "test:test-model",
    });
  });

  it("delivers reminders to the durable verified owner phone", async () => {
    const store = {
      isScheduledTriggerCancelled: vi.fn(async () => false),
      getVerifiedOwnerPhone: vi.fn(async () => "+15555550123"),
      saveAssistantMessage: vi.fn(async () => undefined),
    } as unknown as OpenInstinctStore;
    const messenger = {
      sendMessage: vi.fn(async () => ({
        message_id: "reminder-message",
        status: "sent",
      })),
    };
    const processor = new JobProcessor({
      store,
      env: { ...env, BLOOIO_OWNER_PHONE: "+15555550999" },
      messenger,
      model: {} as ResolvedLanguageModel,
    });

    await processor.process({
      type: "deliver_reminder",
      triggerId: "44444444-4444-4444-8444-444444444444",
      occurrenceAt: "2026-09-01T12:00:00.000Z",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      conversationId: "33333333-3333-4333-8333-333333333333",
      message: "Review the release",
    });

    expect(messenger.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: "+15555550123" }),
    );
    expect(messenger.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ to: "+15555550999" }),
    );
  });

  it("fails closed when a workspace has no verified outbound phone", async () => {
    const store = {
      isScheduledTriggerCancelled: vi.fn(async () => false),
      getVerifiedOwnerPhone: vi.fn(async () => undefined),
      saveAssistantMessage: vi.fn(async () => undefined),
    } as unknown as OpenInstinctStore;
    const messenger = { sendMessage: vi.fn() };
    const processor = new JobProcessor({
      store,
      env,
      messenger,
      model: {} as ResolvedLanguageModel,
    });

    await expect(
      processor.process({
        type: "deliver_reminder",
        triggerId: "44444444-4444-4444-8444-444444444444",
        occurrenceAt: "2026-09-01T12:00:00.000Z",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        conversationId: "33333333-3333-4333-8333-333333333333",
        message: "Review the release",
      }),
    ).rejects.toThrow("Verified deployment owner phone was not found.");
    expect(messenger.sendMessage).not.toHaveBeenCalled();
  });

  it("sends browser handoffs to the durable verified owner phone", async () => {
    const store = {
      listPendingBrowserHandoffNotifications: vi.fn(async () => [
        {
          id: "55555555-5555-4555-8555-555555555555",
          workspaceId: "22222222-2222-4222-8222-222222222222",
        },
      ]),
      getVerifiedOwnerPhone: vi.fn(async () => "+15555550123"),
      markBrowserHandoffNotificationSent: vi.fn(async () => undefined),
      recordBrowserHandoffNotificationFailure: vi.fn(async () => undefined),
    } as unknown as OpenInstinctStore;
    const messenger = {
      sendMessage: vi.fn(async () => ({
        message_id: "handoff-message",
        status: "sent",
      })),
    };
    const processor = new JobProcessor({
      store,
      env: { ...env, BLOOIO_OWNER_PHONE: "+15555550999" },
      messenger,
      model: {} as ResolvedLanguageModel,
    });

    await processor.notifyPendingBrowserHandoffs();

    expect(messenger.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: "+15555550123" }),
    );
    expect(store.markBrowserHandoffNotificationSent).toHaveBeenCalledOnce();
  });

  it("persists an approved action result and enqueues model continuation", async () => {
    const action = memoryAction("executing");
    const store = {
      enqueuePendingContinuations: vi
        .fn()
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(1),
      resolveResumeActionId: vi.fn(async () => action.id),
      isExecutionJobFinalized: vi.fn(async () => false),
      getRunContext: vi.fn(async () => ({
        runId: action.runId,
        claimToken: "99999999-9999-4999-8999-999999999999",
        workspaceId: action.workspaceId,
        conversationId: "33333333-3333-4333-8333-333333333333",
        ownerPhone: "+15555550123",
        messages: [],
        toolResults: [],
      })),
      getConnection: vi.fn(async () => undefined),
      recoverInterruptedAction: vi.fn(async () => "none" as const),
      renewRunLease: vi.fn(async () => undefined),
      claimApprovedAction: vi.fn(async () => ({
        action,
        stepId: "55555555-5555-4555-8555-555555555555",
        attempt: 1,
        startedAt: "2026-08-31T12:00:00.000Z",
      })),
      markActionInvocationStarted: vi.fn(async () => undefined),
      markActionResultReceived: vi.fn(async () => undefined),
      persistToolResult: vi.fn(async () => true),
      saveMemory: vi.fn(async () => ({ id: action.id })),
      getMemory: vi.fn(async () => ({
        id: action.id,
        kind: "preference",
        content: "Prefers tea",
        sensitivity: "personal",
      })),
    } as unknown as OpenInstinctStore;
    const messenger = { sendMessage: vi.fn() };
    const processor = new JobProcessor({
      store,
      env,
      messenger,
      model: {} as ResolvedLanguageModel,
    });

    await processor.process({
      type: "resume_run",
      runId: action.runId,
      workspaceId: action.workspaceId,
      actionId: action.id,
    });

    expect(store.getRunContext).toHaveBeenCalledWith(
      action.runId,
      expect.any(String),
      {
        type: "resume_run",
        workspaceId: action.workspaceId,
        actionId: action.id,
      },
    );
    expect(store.renewRunLease).toHaveBeenCalledWith(
      action.runId,
      "99999999-9999-4999-8999-999999999999",
    );
    expect(store.markActionInvocationStarted).toHaveBeenCalledOnce();
    expect(store.persistToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        actionRequestId: action.id,
        certainty: "succeeded",
        retryEligible: false,
        output: { id: action.id, status: "saved" },
      }),
      "99999999-9999-4999-8999-999999999999",
      expect.objectContaining({
        phase: "postcondition",
        outcome: "observed",
        verifier: "openinstinct.memory.readback",
      }),
    );
    expect(store.enqueuePendingContinuations).toHaveBeenCalledTimes(2);
    expect(messenger.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["before_provider_invocation", 0, false, false],
    ["after_provider_invocation_before_response", 1, false, false],
    ["after_response_before_result_persistence", 1, false, false],
    ["after_result_persistence_before_continuation_enqueue", 1, true, false],
    ["after_continuation_enqueue_before_queue_ack", 1, true, true],
  ] as const)(
    "leaves durable recovery state at %s without a second effect",
    async (point, expectedEffects, expectedPersist, expectedContinuation) => {
      const action = memoryAction("executing");
      let effects = 0;
      const store = {
        enqueuePendingContinuations: vi.fn(async () => 0),
        resolveResumeActionId: vi.fn(async () => action.id),
        isExecutionJobFinalized: vi.fn(async () => false),
        getRunContext: vi.fn(async () => ({
          runId: action.runId,
          claimToken: "99999999-9999-4999-8999-999999999999",
          workspaceId: action.workspaceId,
          conversationId: "33333333-3333-4333-8333-333333333333",
          ownerPhone: "+15555550123",
          messages: [],
          toolResults: [],
        })),
        getConnection: vi.fn(async () => undefined),
        recoverInterruptedAction: vi.fn(async () => "none" as const),
        renewRunLease: vi.fn(async () => undefined),
        claimApprovedAction: vi.fn(async () => ({
          action,
          stepId: "55555555-5555-4555-8555-555555555555",
          attempt: 1,
          startedAt: "2026-08-31T12:00:00.000Z",
        })),
        markActionInvocationStarted: vi.fn(async () => undefined),
        markActionResultReceived: vi.fn(async () => undefined),
        persistToolResult: vi.fn(async () => true),
        saveMemory: vi.fn(async () => {
          effects += 1;
          return { id: action.id };
        }),
        getMemory: vi.fn(async () => ({
          id: action.id,
          kind: "preference",
          content: "Prefers tea",
          sensitivity: "personal",
        })),
      } as unknown as OpenInstinctStore;
      const processor = new JobProcessor({
        store,
        env,
        messenger: { sendMessage: vi.fn() },
        model: {} as ResolvedLanguageModel,
        failureInjector: {
          hit(current) {
            if (current === point) throw new Error(`crash:${point}`);
          },
        },
      });

      await expect(
        processor.process({
          type: "resume_run",
          runId: action.runId,
          workspaceId: action.workspaceId,
          actionId: action.id,
        }),
      ).rejects.toThrow(`crash:${point}`);
      expect(effects).toBe(expectedEffects);
      expect(store.persistToolResult).toHaveBeenCalledTimes(
        expectedPersist ? 1 : 0,
      );
      expect(store.enqueuePendingContinuations).toHaveBeenCalledTimes(
        expectedContinuation ? 2 : 1,
      );
    },
  );

  it("recovers an interrupted invocation without calling the provider again", async () => {
    const store = {
      enqueuePendingContinuations: vi.fn(async () => 0),
      resolveResumeActionId: vi.fn(
        async () => "44444444-4444-4444-8444-444444444444",
      ),
      isExecutionJobFinalized: vi.fn(async () => false),
      getRunContext: vi.fn(async () => ({
        runId: "11111111-1111-4111-8111-111111111111",
        claimToken: "99999999-9999-4999-8999-999999999999",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        conversationId: "33333333-3333-4333-8333-333333333333",
        ownerPhone: "+15555550123",
        messages: [],
        toolResults: [],
      })),
      getConnection: vi.fn(async () => undefined),
      recoverInterruptedAction: vi.fn(async () => "continued" as const),
      claimApprovedAction: vi.fn(),
      saveMemory: vi.fn(),
    } as unknown as OpenInstinctStore;
    const processor = new JobProcessor({
      store,
      env,
      messenger: { sendMessage: vi.fn() },
      model: {} as ResolvedLanguageModel,
    });

    await processor.process({
      type: "resume_run",
      runId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      actionId: "44444444-4444-4444-8444-444444444444",
    });

    expect(store.getRunContext).not.toHaveBeenCalled();
    expect(store.claimApprovedAction).not.toHaveBeenCalled();
    expect(store.saveMemory).not.toHaveBeenCalled();
  });

  it("reconciles an unknown internal write read-only without replaying it", async () => {
    const action = memoryAction("unknown");
    const store = {
      claimReconciliationCase: vi.fn(async () => ({
        caseId: "66666666-6666-4666-8666-666666666666",
        unknownResultId: "77777777-7777-4777-8777-777777777777",
        attempt: 1,
        action,
      })),
      getMemory: vi.fn(async () => ({
        id: action.id,
        kind: "preference",
        content: "Prefers tea",
        sensitivity: "personal",
      })),
      renewReconciliationLease: vi.fn(async () => undefined),
      reconcileUnknownResult: vi.fn(async () => ({})),
      markReconciliationInconclusive: vi.fn(async () => undefined),
      saveMemory: vi.fn(),
    } as unknown as OpenInstinctStore;
    const processor = new JobProcessor({
      store,
      env,
      messenger: { sendMessage: vi.fn() },
      model: {} as ResolvedLanguageModel,
    });

    await processor.process({
      type: "reconcile_action",
      caseId: "66666666-6666-4666-8666-666666666666",
      workspaceId: action.workspaceId,
    });

    expect(store.saveMemory).not.toHaveBeenCalled();
    expect(store.reconcileUnknownResult).toHaveBeenCalledWith(
      expect.objectContaining({
        unknownResultId: "77777777-7777-4777-8777-777777777777",
        certainty: "reconciled_succeeded",
      }),
    );
    expect(store.markReconciliationInconclusive).not.toHaveBeenCalled();
  });
});
