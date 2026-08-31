import { NextResponse } from "next/server";
import { requireOwner } from "../../../../src/lib/owner";
import { isSameOrigin } from "../../../../src/lib/request-security";
import { feedbackUrl } from "../../../../src/lib/feedback";
import { startMcpConnection } from "../../../../src/lib/mcp-connections";

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return NextResponse.json({ error: "Invalid origin." }, { status: 403 });
  const { workspace } = await requireOwner();
  if (!workspace)
    return NextResponse.redirect(
      feedbackUrl(request.url, "session-expired"),
      303,
    );
  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim();
  const url = String(form.get("url") ?? "").trim();
  const bearerToken = String(form.get("bearerToken") ?? "").trim() || undefined;
  if (!name || !url)
    return NextResponse.redirect(feedbackUrl(request.url, "mcp-invalid"), 303);
  let result;
  try {
    result = await startMcpConnection({
      workspaceId: workspace.id,
      name,
      url,
      bearerToken,
    });
  } catch {
    return NextResponse.redirect(feedbackUrl(request.url, "mcp-failed"), 303);
  }
  if (result.type === "authorization")
    return NextResponse.redirect(result.url, 303);
  return NextResponse.redirect(feedbackUrl(request.url, "mcp-connected"), 303);
}
