import { NextResponse } from "next/server";
import { payloadHash } from "@openinstinct/core";
import { cookies } from "next/headers";
import { requireOwner } from "../../../../src/lib/owner";
import {
  browserProvider,
  browserStore,
} from "../../../../src/lib/browser-service";

export async function GET(request: Request) {
  const { workspace } = await requireOwner();
  if (!workspace) return new NextResponse("Not found", { status: 404 });
  const token =
    (await cookies()).get("openinstinct_browser_takeover")?.value ?? "";
  const store = browserStore();
  try {
    const session = await store.getBrowserControlSession({
      nonceHash: payloadHash(token),
      workspaceId: workspace.id,
    });
    await store.recordBrowserTakeoverAccess({
      sessionId: session.id,
      profileId: session.profileId,
      workspaceId: workspace.id,
    });
    const capability = await browserProvider().takeover(
      session.providerSessionId,
    );
    if (new Date(capability.expiresAt).getTime() <= Date.now())
      throw new Error("Provider takeover session expired.");
    const response = NextResponse.redirect(capability.url, 302);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  } catch {
    return new NextResponse(
      "Takeover authorization is unavailable or expired.",
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  } finally {
    await store.close();
  }
}
