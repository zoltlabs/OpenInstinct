import { NextResponse } from "next/server";
import { payloadHash } from "@openinstinct/core";
import { cookies } from "next/headers";
import { requireOwner } from "../../../../src/lib/owner";
import { isSameOrigin } from "../../../../src/lib/request-security";
import {
  browserProvider,
  browserStore,
} from "../../../../src/lib/browser-service";

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return new NextResponse("Forbidden", { status: 403 });
  const { workspace } = await requireOwner();
  if (!workspace) return new NextResponse("Not found", { status: 404 });
  const cookieStore = await cookies();
  const token = cookieStore.get("openinstinct_browser_takeover")?.value ?? "";
  const provider = browserProvider();
  const store = browserStore();
  let session:
    | {
        id: string;
        profileId: string;
        providerSessionId: string;
        purpose: string;
        status: "active" | "completed";
        configurationVersion: number;
        authenticationVerified?: boolean;
        expiresAt: string;
      }
    | undefined;
  try {
    session = await store.getBrowserControlSession({
      nonceHash: payloadHash(token),
      workspaceId: workspace.id,
      allowCompleted: true,
    });
    if (session.status === "completed") {
      const response = NextResponse.redirect(
        new URL(
          `/?feedback=${session.authenticationVerified ? "browser-active" : "browser-login-needed"}`,
          request.url,
        ),
        303,
      );
      response.cookies.set("openinstinct_browser_takeover", "", {
        httpOnly: true,
        path: "/api/browser",
        maxAge: 0,
      });
      return response;
    }
    const profile = await store.getBrowserProfileForManagement({
      id: session.profileId,
      workspaceId: workspace.id,
      configurationVersion: session.configurationVersion,
    });
    const observation = await provider.observe(session.providerSessionId);
    const exactOrigin = profile.allowedOrigins.includes(
      new URL(observation.url).origin,
    );
    const health = await provider.sessionHealth(session.providerSessionId);
    const verification = await provider.verifyAuthentication(
      session.providerSessionId,
      profile.allowedOrigins[0] ?? "",
    );
    const authenticated =
      exactOrigin && health.healthy && verification.verified;
    await provider.checkpointSession(session.providerSessionId);
    await provider.closeSession(session.providerSessionId);
    await store.completeBrowserEnrollment({
      profileId: profile.id,
      workspaceId: workspace.id,
      sessionId: session.id,
      authenticated,
    });
    const response = NextResponse.redirect(
      new URL(
        `/?feedback=${authenticated ? "browser-active" : "browser-login-needed"}`,
        request.url,
      ),
      303,
    );
    response.cookies.set("openinstinct_browser_takeover", "", {
      httpOnly: true,
      path: "/api/browser",
      maxAge: 0,
    });
    return response;
  } catch {
    if (session) {
      const providerClosed = await provider
        .closeSession(session.providerSessionId)
        .then(() => true)
        .catch(() => false);
      await store
        .failBrowserEnrollmentSession({
          sessionId: session.id,
          profileId: session.profileId,
          workspaceId: workspace.id,
          configurationVersion: session.configurationVersion,
          providerClosed,
          errorCode: "completion_check_failed",
        })
        .catch(() => undefined);
    }
    const response = NextResponse.redirect(
      new URL("/?feedback=browser-error", request.url),
      303,
    );
    response.cookies.set("openinstinct_browser_takeover", "", {
      httpOnly: true,
      path: "/api/browser",
      maxAge: 0,
    });
    return response;
  } finally {
    await store.close();
  }
}
