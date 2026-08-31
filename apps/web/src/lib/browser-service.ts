import {
  KernelBrowserProvider,
  type BrowserProvider,
} from "@openinstinct/browser";
import { payloadHash } from "@openinstinct/core";
import { OpenInstinctStore } from "@openinstinct/db";
import { randomBytes, randomUUID } from "node:crypto";

export function browserProvider(): BrowserProvider {
  const key = process.env.KERNEL_API_KEY;
  if (!key) throw new Error("Cloud browser is not configured.");
  return new KernelBrowserProvider(key);
}
export function browserStore(): OpenInstinctStore {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required.");
  return new OpenInstinctStore(url);
}
export function exactHttpsOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Enter an exact HTTPS origin without a path, query, fragment, or credentials.",
    );
  return url.origin;
}
export function newTakeoverToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: payloadHash(token) };
}
export async function deleteProviderProfileByExactName(
  provider: BrowserProvider,
  exactName: string,
): Promise<boolean> {
  const matches = (await provider.listProfiles({ exactName })).filter(
    (profile) => profile.name === exactName,
  );
  if (matches.length > 1)
    throw new Error("Provider profile recovery is ambiguous.");
  if (!matches[0]) return true;
  return (await provider.deleteProfile(matches[0].id)).verified;
}
export async function startBrowserEnrollment(input: {
  workspaceId: string;
  label: string;
  origin: string;
}) {
  const store = browserStore();
  const provider = browserProvider();
  const id = randomUUID();
  const providerProfileName = `openinstinct-${id}`;
  let providerId: string | undefined;
  let providerSessionId: string | undefined;
  try {
    const origin = exactHttpsOrigin(input.origin);
    const capabilities = await provider.capabilities();
    await store.createProvisioningBrowserProfile({
      id,
      workspaceId: input.workspaceId,
      provider: "kernel",
      label: input.label.trim(),
      origin,
      capabilities,
    });
    const profile = await provider.createProfile({
      name: providerProfileName,
    });
    providerId = profile.id;
    await store.attachBrowserProviderProfile({
      id,
      workspaceId: input.workspaceId,
      providerProfileId: profile.id,
    });
    const session = await provider.startSession({
      profileId: profile.id,
      startUrl: origin,
      timeoutSeconds: 900,
      purpose: "enrollment",
    });
    providerSessionId = session.id;
    const authorization = newTakeoverToken();
    const sessionId = randomUUID();
    await store.createBrowserControlSession({
      id: sessionId,
      profileId: id,
      workspaceId: input.workspaceId,
      providerSessionId: session.id,
      purpose: "enrollment",
      nonceHash: authorization.hash,
      configurationVersion: 1,
      expiresAt: new Date(
        Math.min(
          new Date(session.expiresAt).getTime(),
          Date.now() + 15 * 60_000,
        ),
      ).toISOString(),
    });
    return { id, sessionId, token: authorization.token };
  } catch (error) {
    if (providerSessionId)
      await provider.closeSession(providerSessionId).catch(() => undefined);
    await store
      .markBrowserProfileError({
        id,
        workspaceId: input.workspaceId,
        errorCode: "enrollment_failed",
        configurationVersion: 1,
        operation: "enrollment",
      })
      .catch(() => undefined);
    let providerAbsenceVerified = false;
    if (providerId) {
      const deletion = await provider
        .deleteProfile(providerId)
        .catch(() => ({ verified: false }));
      providerAbsenceVerified = deletion.verified;
    } else {
      providerAbsenceVerified = await deleteProviderProfileByExactName(
        provider,
        providerProfileName,
      ).catch(() => false);
    }
    if (providerAbsenceVerified)
      try {
        await store.deleteUnprovisionedBrowserProfile({
          id,
          workspaceId: input.workspaceId,
        });
      } catch {
        const sessions = await store
          .revokeBrowserProfile({ id, workspaceId: input.workspaceId })
          .catch(() => []);
        for (const session of sessions) {
          const closed = await provider
            .closeSession(session.providerSessionId)
            .then(() => true)
            .catch(() => false);
          if (closed)
            await store.closeBrowserControlSession({
              id: session.id,
              workspaceId: input.workspaceId,
            });
        }
        await store
          .deleteVerifiedBrowserProfile({
            id,
            workspaceId: input.workspaceId,
          })
          .catch(() => undefined);
      }
    throw error;
  } finally {
    await store.close();
  }
}

export async function startBrowserReauthentication(input: {
  workspaceId: string;
  profileId: string;
}) {
  const store = browserStore();
  const provider = browserProvider();
  let providerSessionId: string | undefined;
  let configurationVersion: number | undefined;
  try {
    configurationVersion = await store.beginBrowserReauthentication({
      id: input.profileId,
      workspaceId: input.workspaceId,
    });
    const profile = await store.getBrowserProfileForManagement({
      id: input.profileId,
      workspaceId: input.workspaceId,
      configurationVersion,
    });
    for (const pending of await store.listActiveBrowserControlSessions({
      profileId: profile.id,
      workspaceId: input.workspaceId,
      beforeConfigurationVersion: configurationVersion,
    })) {
      const closed = await provider
        .closeSession(pending.providerSessionId)
        .then(() => true)
        .catch(() => false);
      if (!closed)
        throw new Error("Previous browser session cleanup is still pending.");
      await store.closeBrowserControlSession({
        id: pending.id,
        workspaceId: input.workspaceId,
      });
    }
    const session = await provider.startSession({
      profileId: profile.providerProfileId,
      startUrl: profile.allowedOrigins[0],
      timeoutSeconds: 900,
      purpose: "reauthentication",
    });
    providerSessionId = session.id;
    const authorization = newTakeoverToken();
    const sessionId = randomUUID();
    await store.createBrowserControlSession({
      id: sessionId,
      profileId: profile.id,
      workspaceId: input.workspaceId,
      providerSessionId: session.id,
      purpose: "reauthentication",
      nonceHash: authorization.hash,
      configurationVersion,
      expiresAt: new Date(
        Math.min(
          new Date(session.expiresAt).getTime(),
          Date.now() + 15 * 60_000,
        ),
      ).toISOString(),
    });
    return { token: authorization.token };
  } catch (error) {
    if (providerSessionId)
      await provider.closeSession(providerSessionId).catch(() => undefined);
    if (configurationVersion !== undefined)
      await store
        .markBrowserProfileError({
          id: input.profileId,
          workspaceId: input.workspaceId,
          errorCode: "reauthentication_failed",
          configurationVersion,
          operation: "reauthentication",
        })
        .catch(() => undefined);
    throw error;
  } finally {
    await store.close();
  }
}
