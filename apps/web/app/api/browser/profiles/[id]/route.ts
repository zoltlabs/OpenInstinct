import { NextResponse } from "next/server";
import { requireOwner } from "../../../../../src/lib/owner";
import { isSameOrigin } from "../../../../../src/lib/request-security";
import {
  browserProvider,
  browserStore,
  deleteProviderProfileByExactName,
  startBrowserReauthentication,
} from "../../../../../src/lib/browser-service";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isSameOrigin(request))
    return new NextResponse("Forbidden", { status: 403 });
  const { workspace } = await requireOwner();
  if (!workspace) return new NextResponse("Not found", { status: 404 });
  const { id } = await params;
  const action = String((await request.formData()).get("action") ?? "");
  if (action === "reauth")
    try {
      const result = await startBrowserReauthentication({
        workspaceId: workspace.id,
        profileId: id,
      });
      const response = NextResponse.redirect(
        new URL("/browser/handoff", request.url),
        303,
      );
      response.cookies.set("openinstinct_browser_takeover", result.token, {
        httpOnly: true,
        secure: new URL(request.url).protocol === "https:",
        sameSite: "strict",
        path: "/api",
        maxAge: 15 * 60,
      });
      return response;
    } catch {
      return NextResponse.redirect(
        new URL("/?feedback=browser-error", request.url),
        303,
      );
    }
  const store = browserStore();
  try {
    const provider = browserProvider();
    if (action === "cleanup") {
      const recovery = await store.getBrowserProfileForRecovery({
        id,
        workspaceId: workspace.id,
      });
      if (!["provisioning", "error"].includes(recovery.status))
        return new NextResponse("Browser profile is not awaiting recovery.", {
          status: 409,
        });
      const providerReference =
        recovery.providerProfileId ?? `openinstinct-${recovery.id}`;
      let absenceVerified: boolean;
      if (recovery.providerProfileId) {
        const health = await provider.profileHealth(providerReference);
        absenceVerified = health.status === "missing";
        if (health.healthy)
          absenceVerified = (await provider.deleteProfile(providerReference))
            .verified;
      } else {
        absenceVerified = await deleteProviderProfileByExactName(
          provider,
          providerReference,
        );
      }
      if (!absenceVerified)
        throw new Error("Provider profile absence could not be verified.");
      if (recovery.providerProfileId) {
        await store.revokeBrowserProfile({
          id,
          workspaceId: workspace.id,
        });
        await store.deleteVerifiedBrowserProfile({
          id,
          workspaceId: workspace.id,
        });
      } else {
        await store.deleteUnprovisionedBrowserProfile({
          id,
          workspaceId: workspace.id,
        });
      }
      return NextResponse.redirect(
        new URL("/?feedback=browser-deleted", request.url),
        303,
      );
    }
    const profile = await store.getBrowserProfileForManagement({
      id,
      workspaceId: workspace.id,
    });
    if (action === "health") {
      const profileHealth = await provider.profileHealth(
        profile.providerProfileId,
      );
      let providerSessionId: string | undefined;
      let observedOrigin: string | undefined;
      let sessionHealthy = false;
      let authenticationVerified = false;
      try {
        if (profileHealth.healthy) {
          const session = await provider.startSession({
            profileId: profile.providerProfileId,
            startUrl: profile.allowedOrigins[0],
            timeoutSeconds: 60,
            purpose: "health",
          });
          providerSessionId = session.id;
          const observation = await provider.observe(session.id);
          observedOrigin = new URL(observation.url).origin;
          sessionHealthy = (await provider.sessionHealth(session.id)).healthy;
          authenticationVerified = (
            await provider.verifyAuthentication(
              session.id,
              profile.allowedOrigins[0] ?? "",
            )
          ).verified;
        }
      } finally {
        if (providerSessionId)
          await provider.closeSession(providerSessionId).catch(() => undefined);
      }
      const authenticated =
        authenticationVerified &&
        observedOrigin !== undefined &&
        profile.allowedOrigins.includes(observedOrigin);
      await store.recordBrowserProfileHealth({
        id,
        workspaceId: workspace.id,
        healthy:
          profileHealth.healthy &&
          sessionHealthy &&
          observedOrigin !== undefined,
        authenticated,
        configurationVersion: profile.configurationVersion,
        errorCode: profileHealth.healthy
          ? authenticated
            ? undefined
            : "authentication_unconfirmed"
          : "provider_profile_unavailable",
      });
      return NextResponse.redirect(
        new URL(
          `/?feedback=${authenticated ? "browser-active" : "browser-login-needed"}`,
          request.url,
        ),
        303,
      );
    }
    if (action === "revoke") {
      await store.revokeBrowserProfile({ id, workspaceId: workspace.id });
      for (const session of await store.listActiveBrowserControlSessions({
        profileId: id,
        workspaceId: workspace.id,
      })) {
        const closed = await provider
          .closeSession(session.providerSessionId)
          .then(() => true)
          .catch(() => false);
        if (closed)
          await store.closeBrowserControlSession({
            id: session.id,
            workspaceId: workspace.id,
          });
      }
      return NextResponse.redirect(
        new URL("/?feedback=browser-revoked", request.url),
        303,
      );
    }
    if (action === "delete") {
      if (profile.status !== "revoked")
        return new NextResponse("Revoke the profile before deletion.", {
          status: 409,
        });
      for (const session of await store.listActiveBrowserControlSessions({
        profileId: id,
        workspaceId: workspace.id,
      })) {
        const closed = await provider
          .closeSession(session.providerSessionId)
          .then(() => true)
          .catch(() => false);
        if (!closed)
          throw new Error("Provider session cleanup is still pending.");
        await store.closeBrowserControlSession({
          id: session.id,
          workspaceId: workspace.id,
        });
      }
      const result = await provider.deleteProfile(profile.providerProfileId);
      if (!result.verified)
        throw new Error("Provider deletion was not verified.");
      await store.deleteVerifiedBrowserProfile({
        id,
        workspaceId: workspace.id,
      });
      return NextResponse.redirect(
        new URL("/?feedback=browser-deleted", request.url),
        303,
      );
    }
    return new NextResponse("Unsupported action", { status: 400 });
  } catch {
    return NextResponse.redirect(
      new URL("/?feedback=browser-error", request.url),
      303,
    );
  } finally {
    await store.close();
  }
}
