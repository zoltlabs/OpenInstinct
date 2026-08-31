import { randomBytes } from "node:crypto";
import {
  auth,
  type OAuthAuthorizationServerInformation,
  type OAuthClientInformation,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
} from "@ai-sdk/mcp";
import { z } from "zod";
import { assertSafeMcpUrl, createSafeMcpFetch } from "./mcp";

const boundedSecret = z.string().min(1).max(100_000);

const oauthTokensSchema = z.object({
  access_token: boundedSecret,
  id_token: boundedSecret.optional(),
  token_type: z.string().min(1).max(100),
  expires_in: z.number().nonnegative().optional(),
  scope: z.string().max(10_000).optional(),
  refresh_token: boundedSecret.optional(),
  issuer: z.string().url().optional(),
  authorization_server: z.string().url().optional(),
  token_endpoint: z.string().url().optional(),
});

const oauthClientInformationSchema = z.object({
  client_id: boundedSecret,
  client_secret: boundedSecret.optional(),
  client_id_issued_at: z.number().optional(),
  client_secret_expires_at: z.number().optional(),
  issuer: z.string().url().optional(),
  authorization_server: z.string().url().optional(),
  token_endpoint: z.string().url().optional(),
});

const authorizationServerInformationSchema = z.object({
  issuer: z.string().optional(),
  authorizationServerUrl: z.string().url(),
  tokenEndpoint: z.string().url(),
});

export const mcpCredentialSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("bearer"), bearerToken: boundedSecret }),
  z.object({
    kind: z.literal("oauth"),
    connectionId: z.string().uuid(),
    redirectUrl: z.string().url(),
    state: z.string().max(1_000).optional(),
    codeVerifier: z.string().max(2_000).optional(),
    flowExpiresAt: z.string().datetime().optional(),
    connectedAt: z.string().datetime().optional(),
    clientInformation: oauthClientInformationSchema.optional(),
    authorizationServerInformation:
      authorizationServerInformationSchema.optional(),
    tokens: oauthTokensSchema.optional(),
  }),
]);

export type McpCredential = z.infer<typeof mcpCredentialSchema>;
export type McpOAuthCredential = Extract<McpCredential, { kind: "oauth" }>;

export function parseMcpCredential(value: unknown): McpCredential {
  const parsed = mcpCredentialSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const legacy = z
    .object({ bearerToken: z.string().optional() })
    .safeParse(value);
  if (legacy.success && legacy.data.bearerToken)
    return { kind: "bearer", bearerToken: legacy.data.bearerToken };
  if (legacy.success) return { kind: "none" };
  throw new Error("Stored MCP credentials are invalid.");
}

export function createPendingMcpOAuthCredential(input: {
  connectionId: string;
  redirectUrl: string;
  expiresInMs?: number;
}): McpOAuthCredential {
  const nonce = randomBytes(32).toString("base64url");
  return mcpCredentialSchema.parse({
    kind: "oauth",
    connectionId: input.connectionId,
    redirectUrl: input.redirectUrl,
    state: `${input.connectionId}.${nonce}`,
    flowExpiresAt: new Date(
      Date.now() + (input.expiresInMs ?? 10 * 60_000),
    ).toISOString(),
  }) as McpOAuthCredential;
}

export function connectionIdFromMcpOAuthState(
  state: string,
): string | undefined {
  const connectionId = state.split(".", 1)[0];
  return z.string().uuid().safeParse(connectionId).success
    ? connectionId
    : undefined;
}

export class OpenInstinctMcpOAuthProvider implements OAuthClientProvider {
  #credential: McpOAuthCredential;
  #authorizationUrl?: URL;
  readonly #persist?: (credential: McpOAuthCredential) => Promise<void>;

  constructor(input: {
    credential: McpOAuthCredential;
    persist?: (credential: McpOAuthCredential) => Promise<void>;
  }) {
    this.#credential = mcpCredentialSchema.parse(
      input.credential,
    ) as McpOAuthCredential;
    this.#persist = input.persist;
  }

  get credential(): McpOAuthCredential {
    return this.#credential;
  }

  get authorizationUrl(): URL | undefined {
    return this.#authorizationUrl;
  }

  get redirectUrl(): string {
    return this.#credential.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    const redirect = new URL(this.redirectUrl);
    return {
      redirect_uris: [this.redirectUrl],
      application_type: "web",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "OpenInstinct",
      client_uri: redirect.origin,
    };
  }

  tokens(): OAuthTokens | undefined {
    return this.#credential.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.#save({
      tokens: {
        ...tokens,
        refresh_token:
          tokens.refresh_token ?? this.#credential.tokens?.refresh_token,
      },
    });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    assertSafeMcpUrl(authorizationUrl.toString());
    this.#authorizationUrl = authorizationUrl;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.#save({ codeVerifier });
  }

  codeVerifier(): string {
    if (!this.#credential.codeVerifier)
      throw new Error("MCP OAuth code verifier is unavailable.");
    return this.#credential.codeVerifier;
  }

  clientInformation(): OAuthClientInformation | undefined {
    return this.#credential.clientInformation;
  }

  async saveClientInformation(
    clientInformation: OAuthClientInformation,
  ): Promise<void> {
    await this.#save({ clientInformation });
  }

  authorizationServerInformation():
    | OAuthAuthorizationServerInformation
    | undefined {
    return this.#credential.authorizationServerInformation;
  }

  async saveAuthorizationServerInformation(
    authorizationServerInformation: OAuthAuthorizationServerInformation,
  ): Promise<void> {
    await this.#save({ authorizationServerInformation });
  }

  state(): string {
    return (
      this.#credential.state ??
      `${this.#credential.connectionId}.${randomBytes(32).toString("base64url")}`
    );
  }

  async saveState(state: string): Promise<void> {
    await this.#save({ state });
  }

  storedState(): string | undefined {
    return this.#credential.state;
  }

  validateAuthorizationServerURL(
    _serverUrl: string | URL,
    authorizationServerUrl: string | URL,
  ): void {
    assertSafeMcpUrl(String(authorizationServerUrl));
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier",
  ): Promise<void> {
    if (scope === "all") {
      await this.#replace({
        kind: "oauth",
        connectionId: this.#credential.connectionId,
        redirectUrl: this.#credential.redirectUrl,
        state: `${this.#credential.connectionId}.${randomBytes(32).toString("base64url")}`,
        flowExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
      return;
    }
    if (scope === "client") await this.#save({ clientInformation: undefined });
    if (scope === "tokens") await this.#save({ tokens: undefined });
    if (scope === "verifier")
      await this.#save({ codeVerifier: undefined, state: undefined });
  }

  async finishAuthorization(): Promise<void> {
    await this.#save({
      state: undefined,
      codeVerifier: undefined,
      flowExpiresAt: undefined,
      connectedAt: new Date().toISOString(),
    });
  }

  async #save(
    patch: Partial<
      Omit<McpOAuthCredential, "kind" | "connectionId" | "redirectUrl">
    >,
  ): Promise<void> {
    await this.#replace({ ...this.#credential, ...patch });
  }

  async #replace(value: McpOAuthCredential): Promise<void> {
    this.#credential = mcpCredentialSchema.parse(value) as McpOAuthCredential;
    await this.#persist?.(this.#credential);
  }
}

export async function beginMcpOAuth(input: {
  serverUrl: string;
  credential: McpOAuthCredential;
  persist?: (credential: McpOAuthCredential) => Promise<void>;
}): Promise<{
  authorizationUrl: URL;
  credential: McpOAuthCredential;
}> {
  const provider = new OpenInstinctMcpOAuthProvider({
    credential: input.credential,
    persist: input.persist,
  });
  const transport = await createSafeMcpFetch(input.serverUrl);
  try {
    const result = await auth(provider, {
      serverUrl: input.serverUrl,
      fetchFn: transport.fetch,
    });
    if (result !== "REDIRECT" || !provider.authorizationUrl)
      throw new Error("MCP OAuth did not produce an authorization URL.");
    return {
      authorizationUrl: provider.authorizationUrl,
      credential: provider.credential,
    };
  } finally {
    await transport.close();
  }
}

export async function completeMcpOAuth(input: {
  serverUrl: string;
  credential: McpOAuthCredential;
  authorizationCode: string;
  callbackState: string;
  callbackIssuer?: string;
  persist?: (credential: McpOAuthCredential) => Promise<void>;
}): Promise<McpOAuthCredential> {
  if (
    !input.credential.flowExpiresAt ||
    new Date(input.credential.flowExpiresAt).getTime() <= Date.now()
  )
    throw new Error("MCP OAuth request expired.");
  const provider = new OpenInstinctMcpOAuthProvider({
    credential: input.credential,
    persist: input.persist,
  });
  const transport = await createSafeMcpFetch(input.serverUrl);
  try {
    const result = await auth(provider, {
      serverUrl: input.serverUrl,
      authorizationCode: input.authorizationCode,
      callbackState: input.callbackState,
      callbackIssuer: input.callbackIssuer,
      fetchFn: transport.fetch,
    });
    if (result !== "AUTHORIZED")
      throw new Error("MCP OAuth authorization did not complete.");
    await provider.finishAuthorization();
    return provider.credential;
  } finally {
    await transport.close();
  }
}
