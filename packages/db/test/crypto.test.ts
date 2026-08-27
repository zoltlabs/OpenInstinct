import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptCredential, encryptCredential } from "../src/index";

describe("credential encryption", () => {
  it("binds ciphertext to workspace and connection", () => {
    const encodedKey = randomBytes(32).toString("base64");
    const encrypted = encryptCredential({
      plaintext: "secret-token",
      encodedKey,
      workspaceId: "workspace-1",
      connectionId: "connection-1",
    });
    expect(
      decryptCredential({
        encrypted,
        encodedKey,
        workspaceId: "workspace-1",
        connectionId: "connection-1",
      }),
    ).toBe("secret-token");
    expect(() =>
      decryptCredential({
        encrypted,
        encodedKey,
        workspaceId: "workspace-2",
        connectionId: "connection-1",
      }),
    ).toThrow();
  });
});
