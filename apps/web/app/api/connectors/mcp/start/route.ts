import { getMcpConnectorById } from "@openinstinct/connectors";
import { NextResponse } from "next/server";
import { feedbackUrl } from "../../../../../src/lib/feedback";
import { startMcpConnection } from "../../../../../src/lib/mcp-connections";
import { requireOwner } from "../../../../../src/lib/owner";

export async function GET(request: Request) {
  const { workspace } = await requireOwner();
  if (!workspace) return NextResponse.redirect(new URL("/", request.url));
  const requestUrl = new URL(request.url);
  const catalogId = requestUrl.searchParams.get("catalog");
  const catalog = catalogId ? getMcpConnectorById(catalogId) : undefined;
  const url = catalog?.url ?? requestUrl.searchParams.get("url")?.trim();
  const name =
    catalog?.name ?? requestUrl.searchParams.get("name")?.trim() ?? "MCP";
  if (!url)
    return NextResponse.redirect(feedbackUrl(request.url, "mcp-invalid"));
  try {
    const result = await startMcpConnection({
      workspaceId: workspace.id,
      name,
      url,
      catalogId: catalog?.id,
    });
    return result.type === "authorization"
      ? NextResponse.redirect(result.url)
      : NextResponse.redirect(feedbackUrl(request.url, "mcp-connected"));
  } catch {
    return NextResponse.redirect(feedbackUrl(request.url, "mcp-failed"));
  }
}
