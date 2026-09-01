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

interface ByteResponseBody {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(reason?: unknown): Promise<void>;
    releaseLock(): void;
  };
}

export async function readBoundedResponseText(
  body: ByteResponseBody | null,
  maxBytes: number,
  errorMessage: string,
): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel(errorMessage);
        throw new Error(errorMessage);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

export function readBoundedWebResponseText(
  body: ByteResponseBody | null,
  maxBytes = 1_000_000,
): Promise<string> {
  return readBoundedResponseText(body, maxBytes, "Web response is too large.");
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
    const body = await readBoundedWebResponseText(response.body);
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
