import { randomUUID } from "node:crypto";
import {
  beginMcpOAuth,
  completeMcpOAuth,
  connectRemoteMcp,
  createPendingMcpOAuthCredential,
  discoverMcpTools,
  isMcpAuthorizationRequired,
  mcpCredentialSchema,
  OpenInstinctMcpOAuthProvider,
  parseMcpCredential,
  type McpCredential,
  type McpOAuthCredential,
} from "@openinstinct/connectors";
import {
  decryptCredential,
  encryptCredential,
  OpenInstinctStore,
} from "@openinstinct/db";

export type McpConnectionStartResult =
  | { readonly type: "connected" }
  | { readonly type: "authorization"; readonly url: URL };

function connectionEnvironment() {
  const databaseUrl = process.env.DATABASE_URL;
  const encryptionKey = process.env.SECRET_ENCRYPTION_KEY;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!databaseUrl || !encryptionKey || !appUrl)
    throw new Error("MCP connection environment is incomplete.");
  return { databaseUrl, encryptionKey, appUrl };
}

function encryptMcpCredential(input: {
  credential: McpCredential;
  encryptionKey: string;
  workspaceId: string;
  connectionId: string;
}) {
  return encryptCredential({
    plaintext: JSON.stringify(mcpCredentialSchema.parse(input.credential)),
    encodedKey: input.encryptionKey,
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
  });
}

export async function startMcpConnection(input: {
  workspaceId: string;
  name: string;
  url: string;
  bearerToken?: string;
  catalogId?: string;
}): Promise<McpConnectionStartResult> {
  const env = connectionEnvironment();
  const connectionId = randomUUID();
  const configVersion = randomUUID();
  const store = new OpenInstinctStore(env.databaseUrl);
  const baseMetadata = {
    url: input.url,
    configVersion,
    policy: "approval_required",
    ...(input.catalogId ? { catalogId: input.catalogId } : {}),
  };
  try {
    const credential: McpCredential = input.bearerToken
      ? { kind: "bearer", bearerToken: input.bearerToken }
      : { kind: "none" };
    let client;
    try {
      client = await connectRemoteMcp({
        url: input.url,
        bearerToken: input.bearerToken,
      });
    } catch (error) {
      if (input.bearerToken || !isMcpAuthorizationRequired(error)) throw error;

      const pending = createPendingMcpOAuthCredential({
        connectionId,
        redirectUrl: new URL(
          "/api/connectors/mcp/callback",
          env.appUrl,
        ).toString(),
      });
      await store.upsertConnection({
        id: connectionId,
        workspaceId: input.workspaceId,
        provider: "mcp",
        accountId: input.url,
        displayName: input.name,
        scopes: [],
        status: "pending",
        encryptedCredentials: encryptMcpCredential({
          credential: pending,
          encryptionKey: env.encryptionKey,
          workspaceId: input.workspaceId,
          connectionId,
        }),
        metadata: { ...baseMetadata, authentication: "oauth" },
      });
      try {
        const started = await beginMcpOAuth({
          serverUrl: input.url,
          credential: pending,
          persist: (value) =>
            store.updateConnectionCredentials({
              id: connectionId,
              workspaceId: input.workspaceId,
              status: "pending",
              encryptedCredentials: encryptMcpCredential({
                credential: value,
                encryptionKey: env.encryptionKey,
                workspaceId: input.workspaceId,
                connectionId,
              }),
            }),
        });
        return { type: "authorization", url: started.authorizationUrl };
      } catch (oauthError) {
        await store.updateConnectionStatus({
          id: connectionId,
          workspaceId: input.workspaceId,
          status: "error",
        });
        throw oauthError;
      }
    }

    try {
      const toolManifest = await discoverMcpTools(client);
      await store.upsertConnection({
        id: connectionId,
        workspaceId: input.workspaceId,
        provider: "mcp",
        accountId: input.url,
        displayName: input.name,
        scopes: toolManifest.map((tool) => tool.name),
        encryptedCredentials: encryptMcpCredential({
          credential,
          encryptionKey: env.encryptionKey,
          workspaceId: input.workspaceId,
          connectionId,
        }),
        metadata: {
          ...baseMetadata,
          authentication: input.bearerToken ? "bearer" : "none",
          toolNames: toolManifest.map((tool) => tool.name),
          toolManifest,
        },
      });
    } finally {
      await client.close().catch(() => undefined);
    }
    return { type: "connected" };
  } finally {
    await store.close();
  }
}

export async function completeMcpConnection(input: {
  workspaceId: string;
  connectionId: string;
  code: string;
  state: string;
  issuer?: string;
}): Promise<void> {
  const env = connectionEnvironment();
  const store = new OpenInstinctStore(env.databaseUrl);
  try {
    const connection = await store.getConnectionById({
      id: input.connectionId,
      workspaceId: input.workspaceId,
    });
    if (!connection || connection.provider !== "mcp")
      throw new Error("Pending MCP connection was not found.");
    const serverUrl = connection.metadata.url;
    if (typeof serverUrl !== "string")
      throw new Error("Pending MCP connection URL is missing.");
    const stored = parseMcpCredential(
      JSON.parse(
        decryptCredential({
          encrypted: connection.encryptedCredentials,
          encodedKey: env.encryptionKey,
          workspaceId: input.workspaceId,
          connectionId: input.connectionId,
        }),
      ),
    );
    if (stored.kind !== "oauth")
      throw new Error("Pending MCP connection is not using OAuth.");

    const persist = (credential: McpOAuthCredential) =>
      store.updateConnectionCredentials({
        id: input.connectionId,
        workspaceId: input.workspaceId,
        status: "pending",
        encryptedCredentials: encryptMcpCredential({
          credential,
          encryptionKey: env.encryptionKey,
          workspaceId: input.workspaceId,
          connectionId: input.connectionId,
        }),
      });
    const authorized = await completeMcpOAuth({
      serverUrl,
      credential: stored,
      authorizationCode: input.code,
      callbackState: input.state,
      callbackIssuer: input.issuer,
      persist,
    });
    const provider = new OpenInstinctMcpOAuthProvider({
      credential: authorized,
      persist,
    });
    const client = await connectRemoteMcp({
      url: serverUrl,
      authProvider: provider,
    });
    let toolManifest;
    try {
      toolManifest = await discoverMcpTools(client);
    } finally {
      await client.close().catch(() => undefined);
    }
    const configVersion =
      typeof connection.metadata.configVersion === "string"
        ? connection.metadata.configVersion
        : randomUUID();
    await store.upsertConnection({
      id: connection.id,
      workspaceId: input.workspaceId,
      provider: "mcp",
      accountId: connection.accountId ?? serverUrl,
      displayName: connection.displayName ?? "MCP",
      scopes: toolManifest.map((tool) => tool.name),
      status: "active",
      encryptedCredentials: encryptMcpCredential({
        credential: provider.credential,
        encryptionKey: env.encryptionKey,
        workspaceId: input.workspaceId,
        connectionId: connection.id,
      }),
      metadata: {
        ...connection.metadata,
        url: serverUrl,
        configVersion,
        authentication: "oauth",
        toolNames: toolManifest.map((tool) => tool.name),
        toolManifest,
      },
    });
  } catch (error) {
    await store
      .updateConnectionStatus({
        id: input.connectionId,
        workspaceId: input.workspaceId,
        status: "error",
      })
      .catch(() => undefined);
    throw error;
  } finally {
    await store.close();
  }
}
