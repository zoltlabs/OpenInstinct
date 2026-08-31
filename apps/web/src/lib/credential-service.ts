import { randomUUID } from "node:crypto";
import {
  credentialConfigurationVersion,
  encryptCredentialSecret,
  parseCredentialKeyring,
  withDecryptedCredential,
  type CredentialItem,
  type CredentialSecret,
} from "@openinstinct/credentials";
import { payloadHash } from "@openinstinct/core";
import {
  browserProvider,
  browserStore,
  exactHttpsOrigin,
} from "./browser-service";

export function credentialKeyring() {
  const value = process.env.CREDENTIAL_VAULT_KEYS;
  if (!value)
    throw new Error(
      "Credential vault is disabled until CREDENTIAL_VAULT_KEYS is configured.",
    );
  return parseCredentialKeyring(value);
}

export function credentialEnvelopeContext(item: CredentialItem) {
  return {
    workspaceId: item.workspaceId,
    credentialItemId: item.id,
    kind: item.kind,
    allowedOrigins: item.allowedOrigins,
    recordVersion: item.recordVersion,
    configurationVersion: item.configurationVersion,
  } as const;
}

function usernameHint(username: string): string {
  const at = username.lastIndexOf("@");
  if (at > 0)
    return `${username.slice(0, 1)}***${username.slice(at)}`.slice(0, 200);
  return `${username.slice(0, 1)}***`.slice(0, 200);
}

export async function createCredential(input: {
  workspaceId: string;
  label: string;
  origin: string;
  username: string;
  password: string;
}): Promise<string> {
  const store = browserStore();
  try {
    const id = randomUUID();
    const allowedOrigins = [exactHttpsOrigin(input.origin)];
    const recordVersion = 1;
    const configurationVersion = credentialConfigurationVersion({
      kind: "website_password",
      allowedOrigins,
      recordVersion,
    });
    const keyring = credentialKeyring();
    const item: CredentialItem = {
      id,
      workspaceId: input.workspaceId,
      kind: "website_password",
      label: input.label.trim(),
      usernameHint: usernameHint(input.username),
      allowedOrigins,
      status: "needs_verification",
      recordVersion,
      configurationVersion,
      encryptionKeyVersion: keyring.currentVersion,
      lastVerifiedAt: null,
      rotationDueAt: null,
      revokedAt: null,
    };
    const secret: CredentialSecret = {
      username: input.username,
      password: input.password,
    };
    const envelope = encryptCredentialSecret({
      secret,
      context: credentialEnvelopeContext(item),
      keyring,
    });
    await store.createCredentialItem({ item, envelope });
    return id;
  } finally {
    await store.close();
  }
}

export async function replaceCredential(input: {
  workspaceId: string;
  credentialItemId: string;
  label: string;
  origin: string;
  username: string;
  password: string;
}): Promise<void> {
  const store = browserStore();
  try {
    const existing = (await store.listCredentialItems(input.workspaceId)).find(
      (item) => item.id === input.credentialItemId,
    );
    if (
      !existing ||
      !["active", "needs_verification"].includes(existing.status)
    )
      throw new Error("Credential is unavailable for replacement.");
    const allowedOrigins = [exactHttpsOrigin(input.origin)];
    const recordVersion = existing.recordVersion + 1;
    const configurationVersion = credentialConfigurationVersion({
      kind: existing.kind,
      allowedOrigins,
      recordVersion,
    });
    const keyring = credentialKeyring();
    const item: CredentialItem = {
      ...existing,
      label: input.label.trim(),
      usernameHint: usernameHint(input.username),
      allowedOrigins,
      status: "needs_verification",
      recordVersion,
      configurationVersion,
      encryptionKeyVersion: keyring.currentVersion,
      lastVerifiedAt: null,
      revokedAt: null,
    };
    const envelope = encryptCredentialSecret({
      secret: { username: input.username, password: input.password },
      context: credentialEnvelopeContext(item),
      keyring,
    });
    const sessions = await store.replaceCredentialItem({ item, envelope });
    const provider = browserProvider();
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
  } finally {
    await store.close();
  }
}

export async function injectCredentialIntoControlSession(input: {
  workspaceId: string;
  takeoverToken: string;
  credentialItemId: string;
  usernameSelector: string;
  passwordSelector: string;
  submitSelector?: string;
}): Promise<void> {
  const store = browserStore();
  const provider = browserProvider();
  const claimToken = randomUUID();
  let leaseId: string | undefined;
  let invocationStarted = false;
  let providerSessionId: string | undefined;
  try {
    const session = await store.getBrowserControlSession({
      nonceHash: payloadHash(input.takeoverToken),
      workspaceId: input.workspaceId,
    });
    const observed = await provider.observe(session.providerSessionId);
    const exactOrigin = new URL(observed.url).origin;
    const item = (await store.listCredentialItems(input.workspaceId)).find(
      (candidate) => candidate.id === input.credentialItemId,
    );
    if (!item) throw new Error("Credential metadata is unavailable.");
    const context = {
      workspaceId: input.workspaceId,
      credentialItemId: item.id,
      credentialConfigurationVersion: item.configurationVersion,
      exactOrigin,
      browserProfileId: session.profileId,
      browserProfileConfigurationVersion: session.configurationVersion,
      browserExecutionId: null,
      browserControlSessionId: session.id,
      runId: null,
      actionRequestId: null,
      reason: "Owner requested model-blind browser login injection.",
      fields: {
        usernameSelector: input.usernameSelector,
        passwordSelector: input.passwordSelector,
        ...(input.submitSelector
          ? { submitSelector: input.submitSelector }
          : {}),
        frameOrigin: null,
      },
    };
    const claimed = await store.claimCredentialInjection({
      context,
      claimToken,
    });
    providerSessionId = claimed.providerSessionId;
    leaseId = claimed.leaseId;
    await store.markCredentialInjectionStarted({
      leaseId,
      workspaceId: input.workspaceId,
      claimToken,
    });
    invocationStarted = true;
    await withDecryptedCredential({
      envelope: claimed.envelope,
      context: credentialEnvelopeContext(claimed.item),
      keyring: credentialKeyring(),
      use: async (secret) => {
        const result = await provider.injectCredentialFields(
          claimed.providerSessionId,
          { ...context.fields, exactOrigin, ...secret, timeoutMs: 30_000 },
        );
        if (result.origin !== exactOrigin)
          throw new Error("Origin changed during credential injection.");
      },
    });
    await store.settleCredentialInjection({
      leaseId,
      workspaceId: input.workspaceId,
      claimToken,
      result: "injected",
    });
  } catch (error) {
    if (leaseId && invocationStarted) {
      const session = await store
        .settleCredentialInjection({
          leaseId,
          workspaceId: input.workspaceId,
          claimToken,
          result: "unknown",
        })
        .catch(() => undefined);
      if (providerSessionId) {
        const closed = await provider
          .closeSession(providerSessionId)
          .then(() => true)
          .catch(() => false);
        if (closed && session?.quarantined)
          await store
            .closeBrowserControlSession({
              id: session.id,
              workspaceId: input.workspaceId,
            })
            .catch(() => undefined);
      }
    }
    throw error;
  } finally {
    await store.close();
  }
}
