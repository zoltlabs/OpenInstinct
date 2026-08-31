import { NextResponse } from "next/server";
import { requireOwner } from "../../../../src/lib/owner";
import { isSameOrigin } from "../../../../src/lib/request-security";
import { startBrowserEnrollment } from "../../../../src/lib/browser-service";

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return new NextResponse("Forbidden", { status: 403 });
  const { workspace } = await requireOwner();
  if (!workspace) return new NextResponse("Not found", { status: 404 });
  const form = await request.formData();
  const label = String(form.get("label") ?? "").trim();
  const origin = String(form.get("origin") ?? "").trim();
  if (!label || label.length > 200)
    return NextResponse.redirect(
      new URL("/?feedback=browser-invalid", request.url),
      303,
    );
  try {
    const result = await startBrowserEnrollment({
      workspaceId: workspace.id,
      label,
      origin,
    });
    const response = NextResponse.redirect(
      new URL("/browser/handoff", request.url),
      303,
    );
    response.cookies.set("openinstinct_browser_takeover", result.token, {
      httpOnly: true,
      secure: new URL(request.url).protocol === "https:",
      sameSite: "strict",
      path: "/api/browser",
      maxAge: 15 * 60,
    });
    return response;
  } catch {
    return NextResponse.redirect(
      new URL("/?feedback=browser-error", request.url),
      303,
    );
  }
}
