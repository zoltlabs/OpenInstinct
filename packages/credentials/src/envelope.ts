import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import {
  credentialEnvelopeSchema,
  credentialSecretSchema,
  type CredentialEnvelope,
  type CredentialSecret,
} from "./schemas";

export interface CredentialEnvelopeContext {
  readonly workspaceId: string;
  readonly credentialItemId: string;
  readonly kind: "website_password";
  readonly allowedOrigins: readonly string[];
  readonly recordVersion: number;
  readonly configurationVersion: string;
}

export interface CredentialKeyring {
  readonly currentVersion: number;
  readonly keys: ReadonlyMap<number, Uint8Array>;
}

export function parseCredentialKeyring(value: string): CredentialKeyring {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Credential vault keyring must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Credential vault keyring must be an object.");
  const candidate = parsed as {
    currentVersion?: unknown;
    keys?: unknown;
  };
  if (
    !Number.isInteger(candidate.currentVersion) ||
    (candidate.currentVersion as number) <= 0 ||
    !candidate.keys ||
    typeof candidate.keys !== "object" ||
    Array.isArray(candidate.keys)
  )
    throw new Error("Credential vault keyring metadata is invalid.");
  const keys = new Map<number, Uint8Array>();
  for (const [rawVersion, encoded] of Object.entries(candidate.keys)) {
    const version = Number(rawVersion);
    if (
      !Number.isInteger(version) ||
      version <= 0 ||
      typeof encoded !== "string"
    )
      throw new Error("Credential vault key entry is invalid.");
    const key = Buffer.from(encoded, "base64");
    if (key.byteLength !== 32 || key.toString("base64") !== encoded)
      throw new Error(
        "Credential vault keys must be canonical base64 32-byte keys.",
      );
    keys.set(version, key);
  }
  if (!keys.has(candidate.currentVersion as number))
    throw new Error("Current credential vault wrapping key is unavailable.");
  return { currentVersion: candidate.currentVersion as number, keys };
}

function associatedData(context: CredentialEnvelopeContext): Buffer {
  return Buffer.from(
    JSON.stringify({
      workspaceId: context.workspaceId,
      credentialItemId: context.credentialItemId,
      kind: context.kind,
      allowedOrigins: [...context.allowedOrigins].sort(),
      recordVersion: context.recordVersion,
      configurationVersion: context.configurationVersion,
    }),
    "utf8",
  );
}

function keyFor(keyring: CredentialKeyring, version: number): Buffer {
  const raw = keyring.keys.get(version);
  if (!raw || raw.byteLength !== 32)
    throw new Error(
      `Credential wrapping key version ${version} is unavailable.`,
    );
  return Buffer.from(raw);
}

function encryptBytes(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    nonce: nonce.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

function decryptBytes(
  key: Uint8Array,
  input: { nonce: string; tag: string; ciphertext: string },
  aad: Uint8Array,
): Buffer {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(input.nonce, "base64url"),
  );
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(input.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(input.ciphertext, "base64url")),
    decipher.final(),
  ]);
}

export function encryptCredentialSecret(input: {
  secret: CredentialSecret;
  context: CredentialEnvelopeContext;
  keyring: CredentialKeyring;
}): CredentialEnvelope {
  const secret = credentialSecretSchema.parse(input.secret);
  const aad = associatedData(input.context);
  const dataKey = randomBytes(32);
  const plaintext = Buffer.from(JSON.stringify(secret), "utf8");
  try {
    const payload = encryptBytes(dataKey, plaintext, aad);
    const wrapped = encryptBytes(
      keyFor(input.keyring, input.keyring.currentVersion),
      dataKey,
      aad,
    );
    return credentialEnvelopeSchema.parse({
      version: 1,
      keyVersion: input.keyring.currentVersion,
      wrappedKeyNonce: wrapped.nonce,
      wrappedKeyTag: wrapped.tag,
      wrappedKeyCiphertext: wrapped.ciphertext,
      payloadNonce: payload.nonce,
      payloadTag: payload.tag,
      payloadCiphertext: payload.ciphertext,
    });
  } finally {
    dataKey.fill(0);
    plaintext.fill(0);
  }
}

export async function withDecryptedCredential<T>(input: {
  envelope: CredentialEnvelope;
  context: CredentialEnvelopeContext;
  keyring: CredentialKeyring;
  use: (secret: {
    username: Uint8Array;
    password: Uint8Array;
  }) => T | Promise<T>;
}): Promise<T> {
  const envelope = credentialEnvelopeSchema.parse(input.envelope);
  const aad = associatedData(input.context);
  const dataKey = decryptBytes(
    keyFor(input.keyring, envelope.keyVersion),
    {
      nonce: envelope.wrappedKeyNonce,
      tag: envelope.wrappedKeyTag,
      ciphertext: envelope.wrappedKeyCiphertext,
    },
    aad,
  );
  let plaintext: Buffer | undefined;
  let username: Buffer | undefined;
  let password: Buffer | undefined;
  try {
    plaintext = decryptBytes(
      dataKey,
      {
        nonce: envelope.payloadNonce,
        tag: envelope.payloadTag,
        ciphertext: envelope.payloadCiphertext,
      },
      aad,
    );
    const secret = credentialSecretSchema.parse(
      JSON.parse(plaintext.toString("utf8")),
    );
    username = Buffer.from(secret.username, "utf8");
    password = Buffer.from(secret.password, "utf8");
    return await input.use({ username, password });
  } finally {
    dataKey.fill(0);
    plaintext?.fill(0);
    username?.fill(0);
    password?.fill(0);
  }
}

export function rewrapCredentialEnvelope(input: {
  envelope: CredentialEnvelope;
  context: CredentialEnvelopeContext;
  keyring: CredentialKeyring;
}): CredentialEnvelope {
  const envelope = credentialEnvelopeSchema.parse(input.envelope);
  if (envelope.keyVersion === input.keyring.currentVersion) return envelope;
  const aad = associatedData(input.context);
  const dataKey = decryptBytes(
    keyFor(input.keyring, envelope.keyVersion),
    {
      nonce: envelope.wrappedKeyNonce,
      tag: envelope.wrappedKeyTag,
      ciphertext: envelope.wrappedKeyCiphertext,
    },
    aad,
  );
  try {
    const wrapped = encryptBytes(
      keyFor(input.keyring, input.keyring.currentVersion),
      dataKey,
      aad,
    );
    return credentialEnvelopeSchema.parse({
      ...envelope,
      keyVersion: input.keyring.currentVersion,
      wrappedKeyNonce: wrapped.nonce,
      wrappedKeyTag: wrapped.tag,
      wrappedKeyCiphertext: wrapped.ciphertext,
    });
  } finally {
    dataKey.fill(0);
  }
}

export function encryptEmergencyCredentialExport(input: {
  credentialItemId: string;
  allowedOrigins: readonly string[];
  secret: { username: Uint8Array; password: Uint8Array };
  passphrase: string;
}): string {
  if (input.passphrase.length < 16 || input.passphrase.length > 1_000)
    throw new Error("Emergency export passphrase must be 16–1000 characters.");
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = scryptSync(input.passphrase, salt, 32, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  const plaintext = Buffer.from(
    JSON.stringify({
      version: 1,
      credentialItemId: input.credentialItemId,
      allowedOrigins: [...input.allowedOrigins].sort(),
      username: Buffer.from(input.secret.username).toString("utf8"),
      password: Buffer.from(input.secret.password).toString("utf8"),
    }),
    "utf8",
  );
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from("openinstinct-emergency-export-v1", "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    return JSON.stringify({
      version: 1,
      kdf: "scrypt-n32768-r8-p1",
      cipher: "aes-256-gcm",
      salt: salt.toString("base64url"),
      nonce: nonce.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    });
  } finally {
    key.fill(0);
    plaintext.fill(0);
  }
}
