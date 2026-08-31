import { connectionIdFromMcpOAuthState } from "@openinstinct/connectors";
import { NextResponse } from "next/server";
import { feedbackUrl } from "../../../../../src/lib/feedback";
import { completeMcpConnection } from "../../../../../src/lib/mcp-connections";
import { requireOwner } from "../../../../../src/lib/owner";

export async function GET(request: Request) {
  const { workspace } = await requireOwner();
  if (!workspace) return NextResponse.redirect(new URL("/", request.url));
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const issuer = url.searchParams.get("iss") ?? undefined;
  const connectionId = state ? connectionIdFromMcpOAuthState(state) : undefined;
  if (!code || !state || !connectionId)
    return NextResponse.redirect(feedbackUrl(request.url, "mcp-oauth-failed"));
  try {
    await completeMcpConnection({
      workspaceId: workspace.id,
      connectionId,
      code,
      state,
      issuer,
    });
  } catch {
    return NextResponse.redirect(feedbackUrl(request.url, "mcp-oauth-failed"));
  }
  return NextResponse.redirect(feedbackUrl(request.url, "mcp-connected"));
}
