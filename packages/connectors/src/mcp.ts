import {
  createMCPClient,
  UnauthorizedError,
  type MCPClient,
  type OAuthClientProvider,
} from "@ai-sdk/mcp";
import { lookup as lookupCallback } from "node:dns";
import { lookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch } from "undici";
import { z } from "zod";

const forbiddenHostnames = new Set(["localhost", "metadata.google.internal"]);

export function isPrivateNetworkAddress(rawAddress: string): boolean {
  const address = rawAddress.replace(/^\[|\]$/gu, "").toLowerCase();
  if (!ipaddr.isValid(address)) return true;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === "ipv6") {
    const ipv6 = parsed as ipaddr.IPv6;
    if (ipv6.isIPv4MappedAddress()) parsed = ipv6.toIPv4Address();
  }
  return parsed.range() !== "unicast";
}

export function assertSafeMcpUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:")
    throw new Error("Remote MCP servers must use HTTPS.");
  if (url.username || url.password)
    throw new Error("Remote MCP URLs cannot contain credentials.");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (
    forbiddenHostnames.has(hostname) ||
    hostname.endsWith(".local") ||
    hostname === "0.0.0.0" ||
    hostname === "127.0.0.1" ||
    (isIP(hostname) > 0 && isPrivateNetworkAddress(hostname))
  ) {
    throw new Error("Remote MCP URL resolves to a forbidden local address.");
  }
  return url;
}

export async function connectRemoteMcp(input: {
  url: string;
  bearerToken?: string;
  authProvider?: OAuthClientProvider;
  maxRetries?: number;
}): Promise<MCPClient> {
  const transport = await createSafeMcpFetch(input.url);
  const url = transport.url;
  try {
    const client = await createMCPClient({
      clientName: "openinstinct",
      version: "0.1.0",
      maxRetries: input.maxRetries ?? 0,
      initializationOptions: { signal: AbortSignal.timeout(15_000) },
      transport: {
        type: "http",
        url: url.toString(),
        headers: input.bearerToken
          ? { Authorization: `Bearer ${input.bearerToken}` }
          : undefined,
        authProvider: input.authProvider,
        redirect: "error",
        fetch: transport.fetch,
      },
    });
    const closeClient = client.close.bind(client);
    client.close = async () => {
      try {
        await closeClient();
      } finally {
        await transport.close();
      }
    };
    return client;
  } catch (error) {
    await transport.close();
    throw error;
  }
}

export async function createSafeMcpFetch(rawUrl: string): Promise<{
  url: URL;
  fetch: typeof globalThis.fetch;
  close(): Promise<void>;
}> {
  const url = assertSafeMcpUrl(rawUrl);
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/gu, ""), {
    all: true,
  });
  if (
    !addresses.length ||
    addresses.some(({ address }) => isPrivateNetworkAddress(address))
  ) {
    throw new Error("Remote MCP URL resolves to a forbidden local address.");
  }
  const safeLookup: LookupFunction = (hostname, options, callback) => {
    lookupCallback(hostname, options, (error, address, family) => {
      if (error) return callback(error, address, family);
      const values = Array.isArray(address)
        ? address
        : [{ address, family: family ?? 0 }];
      if (values.some((value) => isPrivateNetworkAddress(value.address))) {
        const blocked = Object.assign(
          new Error("Remote MCP URL resolved to a forbidden local address."),
          { code: "EACCES" },
        );
        return callback(blocked, address, family);
      }
      callback(null, address, family);
    });
  };
  const dispatcher = new Agent({ connect: { lookup: safeLookup } });
  return {
    url,
    fetch: ((resource: RequestInfo | URL, init?: RequestInit) =>
      undiciFetch(resource as string | URL, {
        ...(init as import("undici").RequestInit),
        redirect: "error",
        dispatcher,
      })) as unknown as typeof globalThis.fetch,
    close: () => dispatcher.close(),
  };
}

export function isMcpAuthorizationRequired(error: unknown): boolean {
  return error instanceof UnauthorizedError;
}

export const mcpToolManifestSchema = z
  .array(
    z.object({
      name: z.string().min(1).max(256),
      description: z.string().max(2_000).optional(),
      inputSchema: z.record(z.string(), z.unknown()),
    }),
  )
  .max(100)
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 100_000,
    "Remote MCP tool manifest is too large.",
  );

export type McpToolManifestEntry = z.infer<
  typeof mcpToolManifestSchema
>[number];

export async function discoverMcpTools(
  client: MCPClient,
): Promise<readonly McpToolManifestEntry[]> {
  const tools: McpToolManifestEntry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = await client.listTools({
      params: cursor ? { cursor } : undefined,
      options: { signal: AbortSignal.timeout(10_000) },
    });
    for (const definition of result.tools) {
      if (tools.length >= 100)
        throw new Error("Remote MCP server exposes too many tools.");
      const entry = {
        name: definition.name.slice(0, 256),
        description: definition.description?.slice(0, 2_000),
        inputSchema: JSON.parse(
          JSON.stringify(definition.inputSchema),
        ) as Record<string, unknown>,
      };
      if (Buffer.byteLength(JSON.stringify(entry), "utf8") > 20_000)
        throw new Error("Remote MCP tool metadata is too large.");
      tools.push(entry);
    }
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  if (cursor) throw new Error("Remote MCP tool pagination exceeded its limit.");
  if (Buffer.byteLength(JSON.stringify(tools), "utf8") > 100_000)
    throw new Error("Remote MCP tool manifest is too large.");
  return mcpToolManifestSchema.parse(tools);
}
