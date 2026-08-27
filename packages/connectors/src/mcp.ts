import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { lookup as lookupCallback } from "node:dns";
import { lookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch } from "undici";

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
  maxRetries?: number;
}): Promise<MCPClient> {
  const url = assertSafeMcpUrl(input.url);
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
  try {
    const client = await createMCPClient({
      clientName: "openinstinct",
      version: "0.1.0",
      maxRetries: input.maxRetries ?? 0,
      transport: {
        type: "http",
        url: url.toString(),
        headers: input.bearerToken
          ? { Authorization: `Bearer ${input.bearerToken}` }
          : undefined,
        redirect: "error",
        fetch: ((resource: RequestInfo | URL, init?: RequestInit) =>
          undiciFetch(resource as string | URL, {
            ...(init as import("undici").RequestInit),
            dispatcher,
          })) as unknown as typeof globalThis.fetch,
      },
    });
    const closeClient = client.close.bind(client);
    client.close = async () => {
      try {
        await closeClient();
      } finally {
        await dispatcher.close();
      }
    };
    return client;
  } catch (error) {
    await dispatcher.close();
    throw error;
  }
}
