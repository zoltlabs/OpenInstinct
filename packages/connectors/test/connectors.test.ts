import { describe, expect, it } from "vitest";
import {
  assertSafeMcpUrl,
  assertSafeWebUrl,
  connectionIdFromMcpOAuthState,
  createPendingMcpOAuthCredential,
  createGoogleAuthorization,
  isPrivateNetworkAddress,
  OpenInstinctMcpOAuthProvider,
  parseMcpCredential,
  readBoundedResponseText,
  readBoundedWebResponseText,
  resolveMcpConnectorCandidates,
} from "../src/index";

describe("Google OAuth", () => {
  it("uses PKCE and incremental consent", () => {
    const result = createGoogleAuthorization({
      clientId: "client",
      clientSecret: "secret",
      redirectUri: "https://assistant.example/api/connectors/google/callback",
    });
    const url = new URL(result.url);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(result.codeVerifier.length).toBeGreaterThan(32);
  });
});

describe("web fetch URL policy", () => {
  it("allows only public credential-free HTTPS URLs", () => {
    expect(assertSafeWebUrl("https://example.com/news").hostname).toBe(
      "example.com",
    );
    expect(() => assertSafeWebUrl("http://example.com")).toThrow();
    expect(() => assertSafeWebUrl("https://127.0.0.1/private")).toThrow();
    expect(() => assertSafeWebUrl("https://token@example.com")).toThrow();
  });

  it("reads a safe streamed response through the byte boundary", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello "));
        controller.enqueue(new TextEncoder().encode("world"));
        controller.close();
      },
    });
    await expect(readBoundedWebResponseText(body, 11)).resolves.toBe(
      "hello world",
    );
  });

  it("cancels a streamed response as soon as its byte limit is exceeded", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("1234"));
        controller.enqueue(new TextEncoder().encode("56"));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(readBoundedWebResponseText(body, 5)).rejects.toThrow(
      "Web response is too large.",
    );
    expect(cancelled).toBe(true);
  });

  it("applies the same streaming bound to MCP registry responses", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(256_000));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      readBoundedResponseText(
        body,
        256_000,
        "MCP registry response is too large.",
      ),
    ).rejects.toThrow("MCP registry response is too large.");
    expect(cancelled).toBe(true);
  });
});

describe("MCP URL policy", () => {
  it("requires a public HTTPS endpoint", () => {
    expect(assertSafeMcpUrl("https://mcp.example.com/mcp").hostname).toBe(
      "mcp.example.com",
    );
    expect(() => assertSafeMcpUrl("http://localhost:3000/mcp")).toThrow();
    expect(() => assertSafeMcpUrl("https://192.168.1.10/mcp")).toThrow();
  });

  it("recognizes private IPv4 and IPv6 destinations", () => {
    expect(isPrivateNetworkAddress("10.0.0.1")).toBe(true);
    expect(isPrivateNetworkAddress("fd00::1")).toBe(true);
    expect(isPrivateNetworkAddress("::ffff:7f00:1")).toBe(true);
    expect(isPrivateNetworkAddress("::ffff:a00:1")).toBe(true);
    expect(isPrivateNetworkAddress("8.8.8.8")).toBe(false);
  });

  it("rejects credentials embedded in MCP URLs", () => {
    expect(() =>
      assertSafeMcpUrl("https://token@mcp.example.com/mcp"),
    ).toThrow();
  });
});

describe("MCP connector resolution", () => {
  it("resolves conversational Granola requests from the curated catalog", async () => {
    const candidates = await resolveMcpConnectorCandidates(
      "please connect my Granola meeting notes",
    );

    expect(candidates).toEqual([
      expect.objectContaining({
        id: "granola",
        name: "Granola",
        url: "https://mcp.granola.ai/mcp",
        source: "catalog",
        verified: true,
      }),
    ]);
  });

  it("accepts an owner-supplied public MCP URL without claiming verification", async () => {
    const [candidate] = await resolveMcpConnectorCandidates(
      "https://mcp.example.com/mcp",
    );

    expect(candidate).toEqual(
      expect.objectContaining({
        url: "https://mcp.example.com/mcp",
        source: "owner_url",
        verified: false,
      }),
    );
  });
});

describe("MCP OAuth credentials", () => {
  const connectionId = "88e8807f-0fc8-43ea-877f-63e87db91fcb";
  const redirectUrl = "https://assistant.example/api/connectors/mcp/callback";

  it("binds a short-lived OAuth state to the pending connection", () => {
    const credential = createPendingMcpOAuthCredential({
      connectionId,
      redirectUrl,
    });

    expect(connectionIdFromMcpOAuthState(credential.state ?? "")).toBe(
      connectionId,
    );
    expect(new Date(credential.flowExpiresAt ?? 0).getTime()).toBeGreaterThan(
      Date.now(),
    );
    expect(connectionIdFromMcpOAuthState("not-a-valid-state")).toBeUndefined();
  });

  it("keeps legacy bearer credentials readable", () => {
    expect(parseMcpCredential({ bearerToken: "legacy-token" })).toEqual({
      kind: "bearer",
      bearerToken: "legacy-token",
    });
  });

  it("retains refresh tokens when an OAuth server rotates only access tokens", async () => {
    const provider = new OpenInstinctMcpOAuthProvider({
      credential: {
        ...createPendingMcpOAuthCredential({ connectionId, redirectUrl }),
        tokens: {
          access_token: "old-access",
          refresh_token: "refresh-token",
          token_type: "Bearer",
        },
      },
    });

    await provider.saveTokens({
      access_token: "new-access",
      token_type: "Bearer",
    });

    expect(provider.credential.tokens).toEqual({
      access_token: "new-access",
      refresh_token: "refresh-token",
      token_type: "Bearer",
    });
  });

  it("creates a fresh bounded flow after full credential invalidation", async () => {
    const provider = new OpenInstinctMcpOAuthProvider({
      credential: createPendingMcpOAuthCredential({
        connectionId,
        redirectUrl,
      }),
    });

    await provider.invalidateCredentials("all");

    expect(connectionIdFromMcpOAuthState(provider.credential.state ?? "")).toBe(
      connectionId,
    );
    expect(provider.credential.flowExpiresAt).toBeTruthy();
  });
});
