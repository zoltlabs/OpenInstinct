import { lookup as lookupCallback } from "node:dns";
import { lookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { isPrivateNetworkAddress } from "./mcp";

const forbiddenHostnames = new Set(["localhost", "metadata.google.internal"]);

export function assertSafeWebUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") throw new Error("Web fetch requires HTTPS.");
  if (url.username || url.password)
    throw new Error("Web URLs cannot contain credentials.");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (
    forbiddenHostnames.has(hostname) ||
    hostname.endsWith(".local") ||
    (isIP(hostname) > 0 && isPrivateNetworkAddress(hostname))
  )
    throw new Error("Web URL resolves to a forbidden local address.");
  return url;
}

function plainText(contentType: string, body: string): string {
  if (!contentType.includes("text/html")) return body;
  return body
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/\s+/gu, " ")
    .trim();
}

export async function fetchPublicWebPage(input: {
  url: string;
  maxCharacters?: number;
}): Promise<{ url: string; contentType: string; text: string }> {
  const url = assertSafeWebUrl(input.url);
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/gu, ""), {
    all: true,
  });
  if (
    !addresses.length ||
    addresses.some((item) => isPrivateNetworkAddress(item.address))
  )
    throw new Error("Web URL resolves to a forbidden local address.");
  const safeLookup: LookupFunction = (hostname, options, callback) => {
    lookupCallback(hostname, options, (error, address, family) => {
      if (error) return callback(error, address, family);
      const values = Array.isArray(address)
        ? address
        : [{ address, family: family ?? 0 }];
      if (values.some((item) => isPrivateNetworkAddress(item.address)))
        return callback(
          Object.assign(new Error("Blocked private address."), {
            code: "EACCES",
          }),
          address,
          family,
        );
      callback(null, address, family);
    });
  };
  const dispatcher = new Agent({ connect: { lookup: safeLookup } });
  try {
    const response = await undiciFetch(url, {
      dispatcher,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { accept: "text/html,text/plain,application/json" },
    });
    if (!response.ok)
      throw new Error(`Web fetch failed with ${response.status}.`);
    const contentType =
      response.headers.get("content-type") ?? "application/octet-stream";
    if (!/^(text\/|application\/json)/u.test(contentType))
      throw new Error(
        "Web fetch only supports text, HTML, and JSON responses.",
      );
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > 1_000_000)
      throw new Error("Web response is too large.");
    const body = await response.text();
    if (Buffer.byteLength(body) > 1_000_000)
      throw new Error("Web response is too large.");
    return {
      url: url.toString(),
      contentType,
      text: plainText(contentType, body).slice(
        0,
        input.maxCharacters ?? 24_000,
      ),
    };
  } finally {
    await dispatcher.close();
  }
}
