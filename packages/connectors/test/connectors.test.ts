import { describe, expect, it } from "vitest";
import {
  assertSafeMcpUrl,
  createGoogleAuthorization,
  isPrivateNetworkAddress,
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
