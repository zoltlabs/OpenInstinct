import { BlooioClient } from "@openinstinct/messaging";
import { BoundedArtifactScanner } from "@openinstinct/artifacts";
import { randomUUID } from "node:crypto";
import {
  decryptCredential,
  encryptCredential,
  OpenInstinctStore,
  SupabaseArtifactByteStore,
  type AgentJob,
} from "@openinstinct/db";
import {
  connectRemoteMcp,
  GoogleConnector,
  mcpToolManifestSchema,
  OpenInstinctMcpOAuthProvider,
  oauthTokenSetSchema,
  parseMcpCredential,
  refreshGoogleToken,
} from "@openinstinct/connectors";
import type { ServerEnvironment } from "@openinstinct/runtime";
import type { LanguageModel } from "ai";
import { z } from "zod";
import {
  payloadHash,
  normalizeJsonValue,
  stableJson,
  structuredToolResultSchema,
  type ActionRequest,
} from "@openinstinct/core";
import {
  KernelBrowserProvider,
  type BrowserProvider,
} from "@openinstinct/browser";
import { executeApprovedGoogleAction, runAssistantAgent } from "./agent";
import { PermanentJobError } from "./consumer";
import { createAssistantModel } from "./models";
import {
  AiBrowserReadPlanner,
  type BrowserReadPlanner,
} from "./browser-planner";
import { BrowserResearchRuntime } from "./browser-runtime";
import { ArtifactLifecycleService } from "./artifacts";

export interface OutboundMessenger {
  sendMessage(input: {
    to: string;
    text: string;
    channelId?: string;
    idempotencyKey: string;
  }): Promise<{ message_id: string; status: string }>;
}

export type ExecutionFailpoint =
  | "before_provider_invocation"
  | "after_provider_invocation_before_response"
  | "after_response_before_result_persistence"
  | "after_result_persistence_before_continuation_enqueue"
  | "after_continuation_enqueue_before_queue_ack";

export interface ExecutionFailureInjector {
  hit(point: ExecutionFailpoint): void | Promise<void>;
}

const scheduleCreateInputSchema = z
  .object({
    kind: z.enum(["reminder", "routine"]),
    conversationId: z.string().uuid(),
    message: z.string().min(1).max(4000).optional(),
    prompt: z.string().min(1).max(4000).optional(),
    runAt: z.string().datetime(),
    recurrenceSeconds: z.number().int().min(60).max(31_557_600).optional(),
  })
  .superRefine((item, context) => {
    if (item.kind === "reminder" && !item.message)
      context.addIssue({
        code: "custom",
        message: "Reminder message is required.",
      });
    if (item.kind === "routine" && (!item.prompt || !item.recurrenceSeconds))
      context.addIssue({
        code: "custom",
        message: "Routine prompt and recurrence are required.",
      });
  });

export class JobProcessor {
  readonly #store: OpenInstinctStore;
  readonly #env: ServerEnvironment;
  readonly #messenger?: OutboundMessenger;
  readonly #model: LanguageModel;
  readonly #modelId: string;
  readonly #browser?: BrowserProvider;
  readonly #runAgent: typeof runAssistantAgent;
  readonly #failureInjector?: ExecutionFailureInjector;
  readonly #browserRuntime?: BrowserResearchRuntime;
  readonly #artifacts?: ArtifactLifecycleService;

  constructor(input: {
    store: OpenInstinctStore;
    env: ServerEnvironment;
    messenger?: OutboundMessenger;
    model?: LanguageModel;
    modelId?: string;
    browser?: BrowserProvider;
    runAgent?: typeof runAssistantAgent;
    failureInjector?: ExecutionFailureInjector;
    browserPlanner?: BrowserReadPlanner;
  }) {
    this.#store = input.store;
    this.#env = input.env;
    this.#messenger =
      input.messenger ??
      (input.env.BLOOIO_API_KEY
        ? new BlooioClient({ apiKey: input.env.BLOOIO_API_KEY })
        : undefined);
    const assistantModel = input.model
      ? undefined
      : createAssistantModel(input.env);
    this.#model = input.model ?? assistantModel!.model;
    this.#modelId =
      input.modelId ?? assistantModel?.configuredId ?? "injected-model";
    this.#browser =
      input.browser ??
      (input.env.KERNEL_API_KEY
        ? new KernelBrowserProvider(input.env.KERNEL_API_KEY)
        : undefined);
    this.#runAgent = input.runAgent ?? runAssistantAgent;
    this.#failureInjector = input.failureInjector;
    this.#artifacts = new ArtifactLifecycleService(
      this.#store,
      new SupabaseArtifactByteStore({
        supabaseUrl:
          input.env.SUPABASE_URL ?? input.env.NEXT_PUBLIC_SUPABASE_URL,
        serviceRoleKey: input.env.SUPABASE_SECRET_KEY,
      }),
      new BoundedArtifactScanner(),
    );
    this.#browserRuntime = this.#browser
      ? new BrowserResearchRuntime(
          this.#store,
          this.#browser,
          input.browserPlanner ?? new AiBrowserReadPlanner(this.#model),
          this.#artifacts,
        )
      : undefined;
  }

  async cleanupExpiredBrowserSessions(): Promise<void> {
    if (!this.#browser) return;
    for (const session of await this.#store.listBrowserSessionsPendingCleanup()) {
      const closed = await this.#browser
        .closeSession(session.providerSessionId)
        .then(() => true)
        .catch(() => false);
      if (closed)
        await this.#store.closeBrowserControlSession({
          id: session.id,
          workspaceId: session.workspaceId,
        });
    }
  }

  async cleanupExpiredArtifacts(): Promise<void> {
    for (const artifact of await this.#store.listArtifactsPendingCleanup()) {
      try {
        await this.#artifacts?.delete({
          artifactId: artifact.id,
          workspaceId: artifact.workspaceId,
        });
      } catch {
        await this.#store
          .completeArtifactDeletion({
            id: artifact.id,
            workspaceId: artifact.workspaceId,
            verified: false,
          })
          .catch(() => undefined);
      }
    }
  }

  async notifyPendingBrowserHandoffs(): Promise<void> {
    if (!this.#env.BLOOIO_OWNER_PHONE) return;
    for (const handoff of await this.#store.listPendingBrowserHandoffNotifications()) {
      try {
        await this.#sendMessage({
          to: this.#env.BLOOIO_OWNER_PHONE,
          text: `Owner browser takeover is required: ${new URL(
            `/api/browser/handoffs/${handoff.id}`,
            this.#env.NEXT_PUBLIC_APP_URL,
          ).toString()}`,
          channelId: this.#env.BLOOIO_CHANNEL_ID,
          idempotencyKey: `browser-handoff:${handoff.id}:requested`,
        });
        await this.#store.markBrowserHandoffNotificationSent({
          handoffId: handoff.id,
          workspaceId: handoff.workspaceId,
        });
      } catch {
        await this.#store
          .recordBrowserHandoffNotificationFailure({
            handoffId: handoff.id,
            workspaceId: handoff.workspaceId,
          })
          .catch(() => undefined);
      }
    }
  }

  async process(job: AgentJob, claimToken = randomUUID()): Promise<void> {
    let resumeActionId: string | undefined;
    if (job.type === "browser_slice") {
      if (!this.#browserRuntime)
        throw new PermanentJobError("Cloud browser is not configured.");
      const result = await this.#browserRuntime.processSlice({
        executionId: job.executionId,
        workspaceId: job.workspaceId,
        claimToken,
      });
      if (result.handoffId) await this.notifyPendingBrowserHandoffs();
      return;
    }
    if (job.type === "browser_cleanup") {
      if (!this.#browserRuntime)
        throw new PermanentJobError("Cloud browser is not configured.");
      await this.#browserRuntime.processCleanup({
        executionId: job.executionId,
        workspaceId: job.workspaceId,
        claimToken,
      });
      return;
    }
    if (job.type === "dispatch_schedules") {
      await this.#store.dispatchDueSchedules();
      return;
    }
    if (job.type === "deliver_reminder") {
      if (
        await this.#store.isScheduledTriggerCancelled({
          workspaceId: job.workspaceId,
          triggerId: job.triggerId,
        })
      )
        return;
      if (!this.#env.BLOOIO_OWNER_PHONE)
        throw new PermanentJobError(
          "Blooio is not configured; reminder delivery is unavailable.",
        );
      const text = `Reminder: ${job.message}`;
      const sent = await this.#sendMessage({
        to: this.#env.BLOOIO_OWNER_PHONE,
        text,
        channelId: this.#env.BLOOIO_CHANNEL_ID,
        idempotencyKey: `schedule:${job.triggerId}:${job.occurrenceAt}`,
      });
      await this.#store.saveAssistantMessage({
        workspaceId: job.workspaceId,
        conversationId: job.conversationId,
        content: text,
        providerMessageId: sent.message_id,
        status: sent.status,
      });
      return;
    }
    if (job.type === "resume_run") {
      if ((await this.#store.enqueuePendingContinuations(job.runId)) > 0)
        return;
      resumeActionId = await this.#store.resolveResumeActionId({
        runId: job.runId,
        workspaceId: job.workspaceId,
        actionId: job.actionId,
      });
      if (!resumeActionId) return;
      if (await this.#store.isExecutionJobFinalized(resumeActionId)) return;
      const recovery = await this.#store.recoverInterruptedAction(job.runId);
      if (recovery === "continued") return;
    }

    const claimStage =
      job.type === "resume_run"
        ? {
            type: "resume_run" as const,
            workspaceId: job.workspaceId,
            actionId: resumeActionId!,
          }
        : job.type === "continue_run"
          ? {
              type: "continue_run" as const,
              workspaceId: job.workspaceId,
              toolResultId: job.toolResultId,
            }
          : {
              type: "process_event" as const,
              workspaceId: job.workspaceId,
            };
    const context = await this.#store.getRunContext(
      job.runId,
      claimToken,
      claimStage,
    );
    const googleState = await this.#google(context.workspaceId);
    const google = googleState?.connector;

    if (job.type === "resume_run") {
      const claimed = await this.#store.claimApprovedAction(
        job.runId,
        resumeActionId!,
        context.claimToken,
      );
      if (!claimed) {
        await this.#store.releaseRunClaim(job.runId, context.claimToken);
        return;
      }
      const { action } = claimed;
      await this.#validateApprovedAction({
        action,
        workspaceId: context.workspaceId,
        googleState,
      });
      await this.#store.renewRunLease(job.runId, context.claimToken);
      await this.#hitFailpoint("before_provider_invocation");
      await this.#store.markActionInvocationStarted({
        actionId: action.id,
        workspaceId: action.workspaceId,
        runId: action.runId,
        stepId: claimed.stepId,
        attempt: claimed.attempt,
        claimToken: context.claimToken,
      });
      const outputPromise = this.#executeApprovedAction({
        action,
        workspaceId: context.workspaceId,
        google,
        googleState,
      });
      void outputPromise.catch(() => undefined);
      await this.#hitFailpoint("after_provider_invocation_before_response");
      const rawOutput = await outputPromise;
      const output = normalizeToolOutput(action.toolName, rawOutput);
      await this.#store.markActionResultReceived({
        actionId: action.id,
        workspaceId: action.workspaceId,
        runId: action.runId,
        stepId: claimed.stepId,
        attempt: claimed.attempt,
        claimToken: context.claimToken,
      });
      await this.#hitFailpoint("after_response_before_result_persistence");
      const completedAt = new Date().toISOString();
      const toolResult = structuredToolResultSchema.parse({
        id: randomUUID(),
        workspaceId: action.workspaceId,
        runId: action.runId,
        stepId: claimed.stepId,
        actionRequestId: action.id,
        toolName: action.toolName,
        certainty: "succeeded",
        attempt: claimed.attempt,
        output,
        outputHash: payloadHash(output),
        retryEligible: false,
        startedAt: claimed.startedAt,
        completedAt,
      });
      await this.#store.persistToolResult(toolResult, context.claimToken);
      await this.#hitFailpoint(
        "after_result_persistence_before_continuation_enqueue",
      );
      await this.#store.enqueuePendingContinuations(job.runId);
      await this.#hitFailpoint("after_continuation_enqueue_before_queue_ack");
      return;
    }

    const mcpConnections = await this.#store.listConnections({
      workspaceId: context.workspaceId,
      provider: "mcp",
    });
    const memories = await this.#store.searchMemories({
      workspaceId: context.workspaceId,
      limit: 20,
    });
    const result = await this.#runAgent({
      context,
      store: this.#store,
      google,
      googleConnection: googleState
        ? {
            id: googleState.id,
            account: googleState.account,
            configVersion: googleState.configVersion,
          }
        : undefined,
      model: this.#model,
      appUrl: this.#env.NEXT_PUBLIC_APP_URL,
      browser: this.#browser,
      memories,
      mcpConnections: mcpConnections.map((connection) => ({
        id: connection.id,
        name: connection.displayName ?? "MCP",
        tools: manifestForConnection(connection.metadata),
        configVersion:
          typeof connection.metadata.configVersion === "string"
            ? connection.metadata.configVersion
            : "legacy-unversioned",
      })),
    });
    const sent = await this.#sendMessage({
      to: context.ownerPhone,
      text: result.text,
      channelId: this.#env.BLOOIO_CHANNEL_ID,
      idempotencyKey:
        job.type === "continue_run"
          ? `result:${job.toolResultId}:response`
          : `run:${job.runId}:response`,
    });
    await this.#store.saveAssistantMessage({
      workspaceId: context.workspaceId,
      conversationId: context.conversationId,
      content: result.text,
      providerMessageId: sent.message_id,
      status: sent.status,
    });
    if (!result.pendingAction && !result.pendingBrowserExecutionId) {
      await this.#store.completeRun({
        runId: job.runId,
        claimToken: context.claimToken,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        model: this.#modelId,
      });
    }
  }

  async #sendMessage(
    input: Parameters<OutboundMessenger["sendMessage"]>[0],
  ): Promise<Awaited<ReturnType<OutboundMessenger["sendMessage"]>>> {
    if (!this.#messenger)
      throw new PermanentJobError(
        "Blooio is not configured; outbound delivery is unavailable.",
      );
    return this.#messenger.sendMessage(input);
  }

  async #hitFailpoint(point: ExecutionFailpoint): Promise<void> {
    await this.#failureInjector?.hit(point);
  }

  async #executeApprovedAction(input: {
    action: ActionRequest;
    workspaceId: string;
    google?: GoogleConnector;
    googleState?: {
      connector: GoogleConnector;
      id: string;
      account: string;
      configVersion: string;
    };
  }): Promise<unknown> {
    if (input.action.toolName === "mcp.call")
      return this.#executeMcpAction(input.action, input.workspaceId);
    if (input.action.toolName.startsWith("google.")) {
      if (!input.google || !input.googleState)
        throw new Error("Google connection is unavailable.");
      const approvedConnection = (input.action.input as Record<string, unknown>)
        .googleConnection as Record<string, unknown> | undefined;
      if (
        approvedConnection?.id !== input.googleState.id ||
        approvedConnection?.account !== input.googleState.account ||
        approvedConnection?.configVersion !== input.googleState.configVersion
      )
        throw new Error("Google connection changed after approval.");
      return executeApprovedGoogleAction({
        action: input.action,
        google: input.google,
      });
    }
    return this.#executeSystemAction(input.action, input.workspaceId);
  }

  async #validateApprovedAction(input: {
    action: ActionRequest;
    workspaceId: string;
    googleState?: {
      connector: GoogleConnector;
      id: string;
      account: string;
      configVersion: string;
    };
  }): Promise<void> {
    const value = input.action.input as Record<string, unknown>;
    if (input.action.toolName.startsWith("google.")) {
      if (!input.googleState)
        throw new Error("Google connection is unavailable.");
      const approvedConnection = value.googleConnection as
        | Record<string, unknown>
        | undefined;
      if (
        approvedConnection?.id !== input.googleState.id ||
        approvedConnection?.account !== input.googleState.account ||
        approvedConnection?.configVersion !== input.googleState.configVersion
      )
        throw new Error("Google connection changed after approval.");
      if (input.action.toolName === "google.gmail.create_draft")
        z.object({
          to: z.string().email(),
          subject: z.string().min(1),
          body: z.string().min(1),
        }).parse(value);
      else if (input.action.toolName === "google.calendar.create")
        z.object({
          summary: z.string().min(1),
          description: z.string().optional(),
          startDateTime: z.string().datetime(),
          endDateTime: z.string().datetime(),
          timeZone: z.string().optional(),
          attendees: z.array(z.string().email()).optional(),
        }).parse(value);
      else throw new Error("Unsupported approved Google action.");
      return;
    }
    if (input.action.toolName === "mcp.call") {
      const parsed = z
        .object({
          connectionId: z.string().uuid(),
          toolName: z.string().min(1),
          arguments: z.record(z.string(), z.unknown()).optional(),
          configVersion: z.string().min(1),
        })
        .parse(value);
      const connections = await this.#store.listConnections({
        workspaceId: input.workspaceId,
        provider: "mcp",
      });
      const connection = connections.find(
        (item) => item.id === parsed.connectionId,
      );
      const toolNames = Array.isArray(connection?.metadata.toolNames)
        ? connection.metadata.toolNames.filter(
            (item): item is string => typeof item === "string",
          )
        : [];
      if (
        !connection ||
        !toolNames.includes(parsed.toolName) ||
        connection.metadata.configVersion !== parsed.configVersion ||
        typeof connection.metadata.url !== "string"
      )
        throw new Error("Approved MCP configuration is no longer valid.");
      parseMcpCredential(
        JSON.parse(
          decryptCredential({
            encrypted: connection.encryptedCredentials,
            encodedKey: this.#env.SECRET_ENCRYPTION_KEY,
            workspaceId: input.workspaceId,
            connectionId: connection.id,
          }),
        ),
      );
      return;
    }
    if (input.action.toolName === "memory.save")
      z.object({
        kind: z.enum([
          "profile",
          "episodic",
          "commitment",
          "open_loop",
          "preference",
        ]),
        content: z.string().min(1).max(4000),
        sensitivity: z.enum(["public", "personal", "sensitive"]),
      }).parse(value);
    else if (input.action.toolName === "memory.delete")
      z.object({ memoryId: z.string().uuid() }).parse(value);
    else if (input.action.toolName === "schedule.cancel")
      z.object({ triggerId: z.string().uuid() }).parse(value);
    else if (input.action.toolName === "schedule.create")
      scheduleCreateInputSchema.parse(value);
    else if (input.action.toolName === "browser.run") {
      throw new Error(
        "Browser writes are disabled until semantic authorization is enabled.",
      );
    } else
      throw new Error(`Unsupported approved action: ${input.action.toolName}`);
  }

  async #executeSystemAction(
    action: import("@openinstinct/core").ActionRequest,
    workspaceId: string,
  ): Promise<unknown> {
    const value = action.input as Record<string, unknown>;
    switch (action.toolName) {
      case "memory.save": {
        const parsed = z
          .object({
            kind: z.enum([
              "profile",
              "episodic",
              "commitment",
              "open_loop",
              "preference",
            ]),
            content: z.string().min(1).max(4000),
            sensitivity: z.enum(["public", "personal", "sensitive"]),
          })
          .parse(value);
        return this.#store.saveMemory({
          id: action.id,
          workspaceId,
          ...parsed,
          sourceId: action.id,
        });
      }
      case "memory.delete": {
        const parsed = z.object({ memoryId: z.string().uuid() }).parse(value);
        return this.#store.deleteMemory({
          workspaceId,
          memoryId: parsed.memoryId,
        });
      }
      case "schedule.create": {
        const parsed = scheduleCreateInputSchema.parse(value);
        return this.#store.createScheduledTrigger({
          id: action.id,
          workspaceId,
          kind: parsed.kind,
          payload: {
            conversationId: parsed.conversationId,
            ...(parsed.message ? { message: parsed.message } : {}),
            ...(parsed.prompt ? { prompt: parsed.prompt } : {}),
          },
          runAt: parsed.runAt,
          recurrenceSeconds: parsed.recurrenceSeconds,
        });
      }
      case "schedule.cancel": {
        const parsed = z.object({ triggerId: z.string().uuid() }).parse(value);
        return this.#store.cancelScheduledTrigger({
          workspaceId,
          triggerId: parsed.triggerId,
        });
      }
      case "browser.run": {
        throw new Error(
          "Browser writes are disabled until semantic authorization is enabled.",
        );
      }
      default:
        throw new Error(`Unsupported approved action: ${action.toolName}`);
    }
  }

  async #executeMcpAction(
    action: import("@openinstinct/core").ActionRequest,
    workspaceId: string,
  ) {
    const value = action.input as {
      connectionId?: unknown;
      toolName?: unknown;
      arguments?: unknown;
      configVersion?: unknown;
    };
    if (
      typeof value.connectionId !== "string" ||
      typeof value.toolName !== "string" ||
      typeof value.configVersion !== "string"
    ) {
      throw new Error("Approved MCP action is malformed.");
    }
    const connections = await this.#store.listConnections({
      workspaceId,
      provider: "mcp",
    });
    const connection = connections.find(
      (item) => item.id === value.connectionId,
    );
    if (!connection) throw new Error("Approved MCP connection is unavailable.");
    const toolNames = Array.isArray(connection.metadata.toolNames)
      ? connection.metadata.toolNames.filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    if (!toolNames.includes(value.toolName))
      throw new Error("Approved MCP tool is no longer allowlisted.");
    if (connection.metadata.configVersion !== value.configVersion)
      throw new Error("MCP connection changed after approval.");
    const url = connection.metadata.url;
    if (typeof url !== "string")
      throw new Error("MCP connection URL is missing.");
    let credential = parseMcpCredential(
      JSON.parse(
        decryptCredential({
          encrypted: connection.encryptedCredentials,
          encodedKey: this.#env.SECRET_ENCRYPTION_KEY,
          workspaceId,
          connectionId: connection.id,
        }),
      ),
    );
    const persistOAuth = async (
      value: import("@openinstinct/connectors").McpOAuthCredential,
    ) => {
      credential = value;
      await this.#store.updateConnectionCredentials({
        id: connection.id,
        workspaceId,
        encryptedCredentials: encryptCredential({
          plaintext: JSON.stringify(value),
          encodedKey: this.#env.SECRET_ENCRYPTION_KEY,
          workspaceId,
          connectionId: connection.id,
        }),
      });
    };
    const authProvider =
      credential.kind === "oauth"
        ? new OpenInstinctMcpOAuthProvider({
            credential,
            persist: persistOAuth,
          })
        : undefined;
    const client = await connectRemoteMcp({
      url,
      bearerToken:
        credential.kind === "bearer" ? credential.bearerToken : undefined,
      authProvider,
    });
    try {
      return await client.callTool({
        name: value.toolName,
        arguments:
          value.arguments &&
          typeof value.arguments === "object" &&
          !Array.isArray(value.arguments)
            ? (value.arguments as Record<string, unknown>)
            : {},
        options: { signal: AbortSignal.timeout(30_000) },
      });
    } finally {
      await client.close();
    }
  }

  async #google(workspaceId: string): Promise<
    | {
        connector: GoogleConnector;
        id: string;
        account: string;
        configVersion: string;
      }
    | undefined
  > {
    const connection = await this.#store.getConnection({
      workspaceId,
      provider: "google",
    });
    if (!connection) return;
    const plaintext = decryptCredential({
      encrypted: connection.encryptedCredentials,
      encodedKey: this.#env.SECRET_ENCRYPTION_KEY,
      workspaceId,
      connectionId: connection.id,
    });
    let token = oauthTokenSetSchema.parse(JSON.parse(plaintext));
    if (Date.parse(token.expiresAt) <= Date.now() + 60_000) {
      if (
        !token.refreshToken ||
        !this.#env.GOOGLE_CLIENT_ID ||
        !this.#env.GOOGLE_CLIENT_SECRET ||
        !this.#env.GOOGLE_REDIRECT_URI
      ) {
        throw new Error(
          "Google access token expired; reconnect Google from the control plane.",
        );
      }
      token = await refreshGoogleToken({
        refreshToken: token.refreshToken,
        config: {
          clientId: this.#env.GOOGLE_CLIENT_ID,
          clientSecret: this.#env.GOOGLE_CLIENT_SECRET,
          redirectUri: this.#env.GOOGLE_REDIRECT_URI,
        },
      });
      await this.#store.updateConnectionCredentials({
        id: connection.id,
        workspaceId,
        encryptedCredentials: encryptCredential({
          plaintext: JSON.stringify(token),
          encodedKey: this.#env.SECRET_ENCRYPTION_KEY,
          workspaceId,
          connectionId: connection.id,
        }),
      });
    }
    const account = connection.metadata.accountId;
    const configVersion = connection.metadata.configVersion;
    if (typeof account !== "string" || typeof configVersion !== "string")
      throw new Error(
        "Google connection identity is incomplete; reconnect Google.",
      );
    return {
      connector: new GoogleConnector({ accessToken: token.accessToken }),
      id: connection.id,
      account,
      configVersion,
    };
  }
}

export function normalizeToolOutput(toolName: string, value: unknown): unknown {
  if (value === undefined) return { status: "succeeded" };
  const normalized = normalizeJsonValue(value);
  const serialized = stableJson(normalized);
  const rawOutputHash = payloadHash(normalized);
  if (toolName === "mcp.call" || toolName === "browser.run")
    return {
      status: "succeeded",
      providerOutputOmitted: true,
      rawOutputHash,
      reason: "Untrusted provider output is not retained in plaintext.",
    };
  if (Buffer.byteLength(serialized, "utf8") > 120_000)
    return {
      status: "succeeded",
      outputOmitted: true,
      rawOutputHash,
      reason: "Provider output exceeded the durable result limit.",
    };
  return normalized;
}

function manifestForConnection(
  metadata: Record<string, unknown>,
): readonly import("@openinstinct/connectors").McpToolManifestEntry[] {
  const manifest = mcpToolManifestSchema.safeParse(metadata.toolManifest);
  if (manifest.success) return manifest.data;
  const names = Array.isArray(metadata.toolNames)
    ? metadata.toolNames.filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0 && value.length <= 256,
      )
    : [];
  return names.slice(0, 100).map((name) => ({
    name,
    inputSchema: { type: "object" },
  }));
}
