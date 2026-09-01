import { z } from "zod";
import { assertSafeMcpUrl, createSafeMcpFetch } from "./mcp";
import { readBoundedResponseText } from "./web";

export interface McpConnectorCandidate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly url: string;
  readonly source: "catalog" | "registry" | "owner_url";
  readonly verified: boolean;
}

const connectorCatalog = [
  {
    id: "granola",
    name: "Granola",
    description: "Search and use your Granola meeting notes and transcripts.",
    url: "https://mcp.granola.ai/mcp",
    aliases: ["granola", "meeting notes", "meeting transcripts", "my meetings"],
  },
] as const;

export function listMcpConnectorCatalog(): readonly McpConnectorCandidate[] {
  return connectorCatalog.map(({ aliases: _aliases, ...candidate }) => ({
    ...candidate,
    source: "catalog" as const,
    verified: true,
  }));
}

export function getMcpConnectorById(
  id: string,
): McpConnectorCandidate | undefined {
  return listMcpConnectorCatalog().find((candidate) => candidate.id === id);
}

export async function resolveMcpConnectorCandidates(
  query: string,
): Promise<readonly McpConnectorCandidate[]> {
  const trimmed = query.trim();
  if (URL.canParse(trimmed)) {
    const url = assertSafeMcpUrl(trimmed);
    return [
      {
        id: `owner-url:${url.hostname}`,
        name: url.hostname,
        description: "MCP endpoint supplied by the owner.",
        url: url.toString(),
        source: "owner_url",
        verified: false,
      },
    ];
  }

  const normalized = normalize(trimmed);
  const catalogMatches = connectorCatalog.filter((candidate) =>
    candidate.aliases.some((alias) => {
      const value = normalize(alias);
      return normalized === value || normalized.includes(value);
    }),
  );
  if (catalogMatches.length) {
    return catalogMatches.map(({ aliases: _aliases, ...candidate }) => ({
      ...candidate,
      source: "catalog" as const,
      verified: true,
    }));
  }

  return searchOfficialMcpRegistry(trimmed);
}

const registryResponseSchema = z.object({
  servers: z.array(
    z.object({
      server: z.object({
        name: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        version: z.string(),
        remotes: z
          .array(
            z.object({
              type: z.string(),
              url: z.string().url(),
            }),
          )
          .optional(),
      }),
      _meta: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});

async function searchOfficialMcpRegistry(
  query: string,
): Promise<readonly McpConnectorCandidate[]> {
  if (!query || query.length > 200) return [];
  const registryUrl = new URL(
    "/v0.1/servers",
    "https://registry.modelcontextprotocol.io",
  );
  registryUrl.searchParams.set("search", query);
  registryUrl.searchParams.set("limit", "10");
  const transport = await createSafeMcpFetch(registryUrl.toString());
  try {
    const response = await transport.fetch(registryUrl, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return [];
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > 256_000) return [];
    const text = await readBoundedResponseText(
      response.body,
      256_000,
      "MCP registry response is too large.",
    );
    const parsed = registryResponseSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return [];
    const seen = new Set<string>();
    const candidates: McpConnectorCandidate[] = [];
    for (const item of parsed.data.servers) {
      const remote = item.server.remotes?.find(
        (value) => value.type === "streamable-http",
      );
      if (!remote) continue;
      let url: URL;
      try {
        url = assertSafeMcpUrl(remote.url);
      } catch {
        continue;
      }
      const key = `${item.server.name}:${url.toString()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        id: `registry:${item.server.name}`,
        name: item.server.title ?? item.server.name,
        description:
          item.server.description?.slice(0, 500) ??
          "Remote MCP server from the official registry.",
        url: url.toString(),
        source: "registry",
        verified: false,
      });
      if (candidates.length >= 5) break;
    }
    return candidates;
  } catch {
    return [];
  } finally {
    await transport.close();
  }
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}
