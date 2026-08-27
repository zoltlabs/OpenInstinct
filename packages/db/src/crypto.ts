import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function decodeKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new Error(
      "SECRET_ENCRYPTION_KEY must be a base64-encoded 32-byte key.",
    );
  }
  return key;
}

export function encryptCredential(input: {
  plaintext: string;
  encodedKey: string;
  workspaceId: string;
  connectionId: string;
}): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", decodeKey(input.encodedKey), iv);
  cipher.setAAD(
    Buffer.from(`${input.workspaceId}\0connection\0${input.connectionId}`),
  );
  const ciphertext = Buffer.concat([
    cipher.update(input.plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptCredential(input: {
  encrypted: string;
  encodedKey: string;
  workspaceId: string;
  connectionId: string;
}): string {
  const [version, iv, tag, ciphertext] = input.encrypted.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext) {
    throw new Error("Unsupported encrypted credential format.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    decodeKey(input.encodedKey),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAAD(
    Buffer.from(`${input.workspaceId}\0connection\0${input.connectionId}`),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
