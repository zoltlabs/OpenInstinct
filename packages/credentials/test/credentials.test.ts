import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  encryptCredentialSecret,
  encryptEmergencyCredentialExport,
  filterSensitiveMessage,
  sanitizeGmailMessage,
  rewrapCredentialEnvelope,
  validateCredentialUse,
  withDecryptedCredential,
} from "../src";

const workspaceId = randomUUID();
const credentialItemId = randomUUID();
const context = {
  workspaceId,
  credentialItemId,
  kind: "website_password" as const,
  allowedOrigins: ["https://example.test"],
  recordVersion: 1,
  configurationVersion: "a".repeat(64),
};

describe("credential envelopes", () => {
  it("encrypts per item, binds context, and rotates only the wrapped data key", async () => {
    const firstKey = randomBytes(32);
    const secondKey = randomBytes(32);
    const first = { currentVersion: 1, keys: new Map([[1, firstKey]]) };
    const envelope = encryptCredentialSecret({
      secret: { username: "owner@example.test", password: "canary-secret" },
      context,
      keyring: first,
    });
    expect(envelope.payloadCiphertext).not.toContain("canary-secret");
    const rotated = rewrapCredentialEnvelope({
      envelope,
      context,
      keyring: {
        currentVersion: 2,
        keys: new Map([
          [1, firstKey],
          [2, secondKey],
        ]),
      },
    });
    expect(rotated.payloadCiphertext).toBe(envelope.payloadCiphertext);
    expect(rotated.keyVersion).toBe(2);
    const value = await withDecryptedCredential({
      envelope: rotated,
      context,
      keyring: { currentVersion: 2, keys: new Map([[2, secondKey]]) },
      use: (secret) => ({
        username: Buffer.from(secret.username).toString("utf8"),
        password: Buffer.from(secret.password).toString("utf8"),
      }),
    });
    expect(value).toEqual({
      username: "owner@example.test",
      password: "canary-secret",
    });
    await expect(
      withDecryptedCredential({
        envelope: rotated,
        context: { ...context, allowedOrigins: ["https://lookalike.test"] },
        keyring: { currentVersion: 2, keys: new Map([[2, secondKey]]) },
        use: () => undefined,
      }),
    ).rejects.toThrow();
  });
});

describe("credential policy", () => {
  const item = {
    id: credentialItemId,
    workspaceId,
    kind: "website_password" as const,
    label: "Example",
    usernameHint: "o***@example.test",
    allowedOrigins: ["https://example.test"],
    status: "active" as const,
    recordVersion: 1,
    configurationVersion: "a".repeat(64),
    encryptionKeyVersion: 1,
    lastVerifiedAt: null,
    rotationDueAt: null,
    revokedAt: null,
  };
  const use = {
    workspaceId,
    credentialItemId,
    credentialConfigurationVersion: "a".repeat(64),
    exactOrigin: "https://example.test",
    browserProfileId: randomUUID(),
    browserProfileConfigurationVersion: 1,
    browserExecutionId: null,
    browserControlSessionId: randomUUID(),
    runId: null,
    actionRequestId: null,
    reason: "Authenticate to the canary site.",
    fields: {
      usernameSelector: "#username",
      passwordSelector: "#password",
      frameOrigin: null,
    },
  };
  it("fails closed on origin, version, and cross-frame changes", () => {
    expect(validateCredentialUse({ item, context: use }).item.id).toBe(item.id);
    expect(() =>
      validateCredentialUse({
        item,
        context: { ...use, exactOrigin: "https://lookalike.test" },
      }),
    ).toThrow(/exact origin/u);
    expect(() =>
      validateCredentialUse({
        item,
        context: {
          ...use,
          fields: { ...use.fields, frameOrigin: "https://idp.example.test" },
        },
      }),
    ).toThrow(/Cross-origin/u);
  });

  it("withholds OTP and recovery messages from model context", () => {
    expect(
      filterSensitiveMessage("Your verification code is 123456"),
    ).toMatchObject({
      disposition: "owner_handoff",
      kind: "otp",
    });
    expect(filterSensitiveMessage("Your code is 123456")).toMatchObject({
      disposition: "owner_handoff",
      kind: "otp",
    });
    expect(filterSensitiveMessage("Meeting notes for tomorrow")).toEqual({
      disposition: "allow",
      text: "Meeting notes for tomorrow",
    });
  });

  it("withholds base64url-encoded sensitive Gmail MIME bodies", () => {
    const message = sanitizeGmailMessage({
      id: "gmail-message-1",
      threadId: "gmail-thread-1",
      snippet: "Account notification",
      payload: {
        headers: [{ name: "Subject", value: "Account notification" }],
        parts: [
          {
            mimeType: "text/plain",
            body: {
              data: Buffer.from(
                "Your code is 123456 and expires in 5 minutes",
              ).toString("base64url"),
            },
          },
        ],
      },
    });
    expect(message).toMatchObject({
      id: "gmail-message-1",
      sensitiveContent: { disposition: "owner_handoff", kind: "otp" },
    });
    expect(JSON.stringify(message)).not.toContain("123456");
    expect(JSON.stringify(message)).not.toContain("payload");
  });

  it("withholds code-first and HTML-split Gmail OTP wording", () => {
    for (const body of [
      "123456 is your login code",
      "<p><span>123</span><span>456</span> is your <b>login</b> code</p>",
    ]) {
      const message = sanitizeGmailMessage({
        id: "gmail-adversarial",
        payload: {
          parts: [{ body: { data: Buffer.from(body).toString("base64url") } }],
        },
      });
      expect(message).toMatchObject({
        sensitiveContent: { disposition: "owner_handoff", kind: "otp" },
      });
      expect(JSON.stringify(message)).not.toContain("body");
    }
  });

  it("returns decoded safe Gmail content without raw MIME body data", () => {
    const message = sanitizeGmailMessage({
      id: "gmail-safe",
      payload: {
        body: {
          data: Buffer.from("Quarterly meeting notes").toString("base64url"),
        },
      },
    });
    expect(message).toEqual({
      id: "gmail-safe",
      content: "Quarterly meeting notes",
    });
    expect(JSON.stringify(message)).not.toContain("data");
  });

  it("withholds alphanumeric login codes and magic capability URLs", () => {
    for (const body of [
      "Use your login code A1B2C3",
      "Click here to sign in: https://accounts.example.test/magic?token=SECRET-CAPABILITY",
    ]) {
      const message = sanitizeGmailMessage({
        id: "gmail-capability",
        payload: { body: { data: Buffer.from(body).toString("base64url") } },
      });
      expect(message).toMatchObject({
        sensitiveContent: { disposition: "owner_handoff" },
      });
      expect(JSON.stringify(message)).not.toContain("SECRET-CAPABILITY");
      expect(JSON.stringify(message)).not.toContain("A1B2C3");
    }
  });

  it("never emits plaintext in an emergency export", () => {
    const encrypted = encryptEmergencyCredentialExport({
      credentialItemId,
      allowedOrigins: ["https://example.test"],
      secret: {
        username: Buffer.from("canary-user"),
        password: Buffer.from("canary-password"),
      },
      passphrase: "long-owner-passphrase",
    });
    expect(encrypted).not.toContain("canary-user");
    expect(encrypted).not.toContain("canary-password");
  });
});
