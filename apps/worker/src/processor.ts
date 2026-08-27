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
  oauthTokenSetSchema,
  refreshGoogleToken,
} from "@openinstinct/connectors";
import type { ServerEnvironment } from "@openinstinct/runtime";
import { executeApprovedGoogleAction, runAssistantAgent } from "./agent";
import { PermanentJobError } from "./consumer";

export class JobProcessor {
  readonly #store: OpenInstinctStore;
  readonly #env: ServerEnvironment;
  readonly #blooio: BlooioClient;

  constructor(input: { store: OpenInstinctStore; env: ServerEnvironment }) {
    this.#store = input.store;
    this.#env = input.env;
    this.#blooio = new BlooioClient({ apiKey: input.env.BLOOIO_API_KEY });
  }

  async process(job: AgentJob): Promise<void> {
    if (job.type === "dispatch_schedules") return;
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
        else {
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
        }
        await this.#store.markActionExecuted(action.id);
      } catch (error) {
        await this.#store.markActionUnknown(action.id);
        const text = `I could not confirm whether this approved action completed, so I will not retry it automatically: ${action.summary}`;
        const sent = await this.#blooio.sendMessage({
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
          model: this.#env.AI_MODEL,
        });
        return;
      }
      const text = `Approved action completed: ${action.summary}`;
      const sent = await this.#blooio.sendMessage({
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
        model: this.#env.AI_MODEL,
      });
      return;
    }

    const mcpConnections = await this.#store.listConnections({
      workspaceId: context.workspaceId,
      provider: "mcp",
    });
    const result = await runAssistantAgent({
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
      model: this.#env.AI_MODEL,
      appUrl: this.#env.NEXT_PUBLIC_APP_URL,
      mcpConnections: mcpConnections.map((connection) => ({
        id: connection.id,
        name: connection.displayName ?? "MCP",
        toolNames: Array.isArray(connection.metadata.toolNames)
          ? connection.metadata.toolNames.filter(
              (value): value is string => typeof value === "string",
            )
          : [],
        configVersion:
          typeof connection.metadata.configVersion === "string"
            ? connection.metadata.configVersion
            : "legacy-unversioned",
      })),
    });
    const sent = await this.#blooio.sendMessage({
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
        model: this.#env.AI_MODEL,
      });
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
    const secret = JSON.parse(
      decryptCredential({
        encrypted: connection.encryptedCredentials,
        encodedKey: this.#env.SECRET_ENCRYPTION_KEY,
        workspaceId,
        connectionId: connection.id,
      }),
    ) as { bearerToken?: unknown };
    const client = await connectRemoteMcp({
      url,
      bearerToken:
        typeof secret.bearerToken === "string" ? secret.bearerToken : undefined,
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
