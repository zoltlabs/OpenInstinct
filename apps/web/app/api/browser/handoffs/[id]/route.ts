import { NextResponse } from "next/server";
import { requireOwner } from "../../../../../src/lib/owner";
import { isSameOrigin } from "../../../../../src/lib/request-security";
import {
  browserProvider,
  browserStore,
} from "../../../../../src/lib/browser-service";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { workspace } = await requireOwner();
  if (!workspace) return new NextResponse("Not found", { status: 404 });
  const { id } = await context.params;
  if (!uuid.test(id)) return new NextResponse("Not found", { status: 404 });
  const url = new URL(request.url);
  if (url.searchParams.get("live") !== "1")
    return new NextResponse(handoffPage(id), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        "Referrer-Policy": "no-referrer",
      },
    });
  const store = browserStore();
  try {
    const handoff = await store.accessBrowserExecutionHandoff({
      handoffId: id,
      workspaceId: workspace.id,
    });
    const capability = await browserProvider().takeover(
      handoff.providerSessionId,
    );
    if (new Date(capability.expiresAt).getTime() <= Date.now())
      throw new Error("Provider takeover session expired.");
    const response = NextResponse.redirect(capability.url, 302);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  } catch {
    return new NextResponse("Browser handoff is unavailable or expired.", {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  } finally {
    await store.close();
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  if (!isSameOrigin(request))
    return new NextResponse("Forbidden", { status: 403 });
  const { workspace } = await requireOwner();
  if (!workspace) return new NextResponse("Not found", { status: 404 });
  const { id } = await context.params;
  if (!uuid.test(id)) return new NextResponse("Not found", { status: 404 });
  const store = browserStore();
  try {
    await store.completeBrowserExecutionHandoff({
      handoffId: id,
      workspaceId: workspace.id,
    });
    return NextResponse.redirect(
      new URL("/?feedback=browser-resumed", request.url),
      303,
    );
  } catch {
    return new NextResponse("Browser handoff cannot be completed.", {
      status: 409,
      headers: { "Cache-Control": "no-store" },
    });
  } finally {
    await store.close();
  }
}

function handoffPage(id: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>OpenInstinct browser handoff</title><style>body{font:16px system-ui;max-width:38rem;margin:4rem auto;padding:0 1rem;color:#171717}a,button{display:inline-block;margin:.5rem .5rem .5rem 0;padding:.75rem 1rem;border:1px solid #777;border-radius:.5rem;background:#fff;color:#111;text-decoration:none}</style></head><body><h1>Browser handoff</h1><p>Open the isolated browser in a new tab, complete the owner-only step, then return here and resume automation.</p><a href="/api/browser/handoffs/${id}?live=1" target="_blank" rel="noreferrer">Open isolated browser</a><form method="post"><button type="submit">I’m done — resume</button></form></body></html>`;
}
