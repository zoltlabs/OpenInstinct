import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireOwner } from "../../../../src/lib/owner";
import { isSameOrigin } from "../../../../src/lib/request-security";
import { injectCredentialIntoControlSession } from "../../../../src/lib/credential-service";

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return new NextResponse("Forbidden", { status: 403 });
  const { workspace } = await requireOwner();
  if (!workspace) return new NextResponse("Not found", { status: 404 });
  const form = await request.formData();
  const token =
    (await cookies()).get("openinstinct_browser_takeover")?.value ?? "";
  try {
    await injectCredentialIntoControlSession({
      workspaceId: workspace.id,
      takeoverToken: token,
      credentialItemId: String(form.get("credentialItemId") ?? ""),
      usernameSelector: String(form.get("usernameSelector") ?? ""),
      passwordSelector: String(form.get("passwordSelector") ?? ""),
      ...(String(form.get("submitSelector") ?? "").trim()
        ? { submitSelector: String(form.get("submitSelector")).trim() }
        : {}),
    });
    return NextResponse.redirect(
      new URL("/browser/handoff?credential=injected", request.url),
      303,
    );
  } catch {
    return NextResponse.redirect(
      new URL("/browser/handoff?credential=error", request.url),
      303,
    );
  }
}
