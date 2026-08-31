import { BlooioClient } from "@openinstinct/messaging";
import {
  decryptCredential,
  encryptCredential,
  OpenInstinctStore,
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
  browserActionProgram,
  browserActionSchema,
  KernelBrowserProvider,
  type BrowserProvider,
} from "@openinstinct/browser";
import { assertSafeWebUrl } from "@openinstinct/connectors";
import { executeApprovedGoogleAction, runAssistantAgent } from "./agent";
import { PermanentJobError } from "./consumer";
import { createAssistantModel } from "./models";

export interface OutboundMessenger {
  sendMessage(input: {
    to: string;
    text: string;
    channelId?: string;
    idempotencyKey: string;
  }): Promise<{ message_id: string; status: string }>;
}

export class JobProcessor {
  readonly #store: OpenInstinctStore;
  readonly #env: ServerEnvironment;
  readonly #messenger?: OutboundMessenger;
  readonly #model: LanguageModel;
  readonly #modelId: string;
  readonly #browser?: BrowserProvider;
  readonly #runAgent: typeof runAssistantAgent;

  constructor(input: {
    store: OpenInstinctStore;
    env: ServerEnvironment;
    messenger?: OutboundMessenger;
    model?: LanguageModel;
    modelId?: string;
    browser?: BrowserProvider;
    runAgent?: typeof runAssistantAgent;
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
  }

  async process(job: AgentJob): Promise<void> {
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
    const context = await this.#store.getRunContext(job.runId);
    const googleState = await this.#google(context.workspaceId);
    const google = googleState?.connector;

    if (job.type === "resume_run") {
      const action = await this.#store.claimApprovedAction(job.runId);
      if (!action)
        throw new PermanentJobError(
          "Resumed run has no claimable approved action.",
        );
      try {
        if (action.toolName === "mcp.call")
          await this.#executeMcpAction(action, context.workspaceId);
        else if (action.toolName.startsWith("google.")) {
          if (!google || !googleState)
            throw new Error("Google connection is unavailable.");
          const approvedConnection = (action.input as Record<string, unknown>)
            .googleConnection as Record<string, unknown> | undefined;
          if (
            approvedConnection?.id !== googleState.id ||
            approvedConnection?.account !== googleState.account ||
            approvedConnection?.configVersion !== googleState.configVersion
          )
            throw new Error("Google connection changed after approval.");
          await executeApprovedGoogleAction({ action, google });
        } else {
          await this.#executeSystemAction(action, context.workspaceId);
        }
        await this.#store.markActionExecuted(action.id);
      } catch (error) {
        await this.#store.markActionUnknown(action.id);
        const text = `I could not confirm whether this approved action completed, so I will not retry it automatically: ${action.summary}`;
        const sent = await this.#sendMessage({
          to: context.ownerPhone,
          text,
          channelId: this.#env.BLOOIO_CHANNEL_ID,
          idempotencyKey: `action:${action.id}:unknown`,
        });
        await this.#store.saveAssistantMessage({
          workspaceId: context.workspaceId,
          conversationId: context.conversationId,
          content: text,
          providerMessageId: sent.message_id,
          status: sent.status,
        });
        await this.#store.completeRun({
          runId: job.runId,
          model: this.#modelId,
        });
        return;
      }
      const text = `Approved action completed: ${action.summary}`;
      const sent = await this.#sendMessage({
        to: context.ownerPhone,
        text,
        channelId: this.#env.BLOOIO_CHANNEL_ID,
        idempotencyKey: `action:${action.id}`,
      });
      await this.#store.saveAssistantMessage({
        workspaceId: context.workspaceId,
        conversationId: context.conversationId,
        content: text,
        providerMessageId: sent.message_id,
        status: sent.status,
      });
      await this.#store.completeRun({
        runId: job.runId,
        model: this.#modelId,
      });
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
      idempotencyKey: `run:${job.runId}:response`,
    });
    await this.#store.saveAssistantMessage({
      workspaceId: context.workspaceId,
      conversationId: context.conversationId,
      content: result.text,
      providerMessageId: sent.message_id,
      status: sent.status,
    });
    if (!result.pendingAction) {
      await this.#store.completeRun({
        runId: job.runId,
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
        const parsed = z
          .object({
            kind: z.enum(["reminder", "routine"]),
            conversationId: z.string().uuid(),
            message: z.string().min(1).max(4000).optional(),
            prompt: z.string().min(1).max(4000).optional(),
            runAt: z.string().datetime(),
            recurrenceSeconds: z
              .number()
              .int()
              .min(60)
              .max(31_557_600)
              .optional(),
          })
          .superRefine((item, context) => {
            if (item.kind === "reminder" && !item.message)
              context.addIssue({
                code: "custom",
                message: "Reminder message is required.",
              });
            if (
              item.kind === "routine" &&
              (!item.prompt || !item.recurrenceSeconds)
            )
              context.addIssue({
                code: "custom",
                message: "Routine prompt and recurrence are required.",
              });
          })
          .parse(value);
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
        if (!this.#browser) throw new Error("Cloud browser is not configured.");
        const parsed = browserActionSchema.parse(value);
        assertSafeWebUrl(parsed.startUrl);
        for (const step of parsed.steps)
          if (step.action === "goto") assertSafeWebUrl(step.url);
        if (parsed.profileId) {
          const profiles = await this.#store.listBrowserProfiles(workspaceId);
          if (
            !profiles.some(
              (profile) => profile.providerProfileId === parsed.profileId,
            )
          )
            throw new Error(
              "Browser profile is not registered for this owner.",
            );
        }
        const session = await this.#browser.create({
          startUrl: parsed.startUrl,
          profileId: parsed.profileId,
          timeoutSeconds: 180,
        });
        try {
          return await this.#browser.execute({
            sessionId: session.id,
            code: browserActionProgram(parsed),
            timeoutSeconds: 30,
          });
        } finally {
          await this.#browser.destroy(session.id);
        }
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
