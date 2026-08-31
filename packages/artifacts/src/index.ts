import { createHash } from "node:crypto";
import { z } from "zod";

export const artifactKindSchema = z.enum([
  "screenshot",
  "dom",
  "download",
  "upload",
  "receipt",
  "trace",
]);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

export const artifactSensitivitySchema = z.enum([
  "public",
  "personal",
  "sensitive",
  "secret",
]);
export type ArtifactSensitivity = z.infer<typeof artifactSensitivitySchema>;

export const artifactStateSchema = z.enum([
  "pending_upload",
  "quarantined",
  "scanning",
  "available",
  "rejected",
  "deletion_pending",
  "deleted",
  "deletion_unknown",
]);
export type ArtifactState = z.infer<typeof artifactStateSchema>;

export const artifactScanResultSchema = z.object({
  verdict: z.enum(["clean", "malicious", "unsupported", "error"]),
  scannerVersion: z.string().min(1).max(100),
  safeCode: z.string().min(1).max(128).optional(),
});
export type ArtifactScanResult = z.infer<typeof artifactScanResultSchema>;

export interface ArtifactByteStore {
  put(input: {
    workspaceId: string;
    artifactId: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<{ storageKey: string; etag?: string }>;
  head(storageKey: string): Promise<{
    exists: boolean;
    sizeBytes?: number;
    contentType?: string;
  }>;
  read(storageKey: string, maxBytes: number): Promise<Uint8Array>;
  delete(storageKey: string): Promise<void>;
  verifyDeleted(storageKey: string): Promise<boolean>;
}

export interface ArtifactScanner {
  scan(input: {
    bytes: Uint8Array;
    declaredMimeType: string;
    maxBytes: number;
  }): Promise<ArtifactScanResult>;
}

export interface ArtifactRedactor {
  readonly version: string;
  redact(input: {
    kind: "screenshot" | "dom";
    bytes: Uint8Array;
    mimeType: string;
  }): Promise<{ bytes: Uint8Array; mimeType: string }>;
}

export function artifactSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sanitizedArtifactName(value: string): string {
  const name = value
    .replaceAll(/[^a-zA-Z0-9._-]/gu, "_")
    .replace(/^\.+/u, "_")
    .slice(0, 200);
  if (!name || name === "." || name === "..")
    throw new Error("Artifact name is invalid.");
  return name;
}

export class InMemoryArtifactByteStore implements ArtifactByteStore {
  readonly #objects = new Map<
    string,
    { bytes: Uint8Array; contentType: string }
  >();
  async put(input: {
    workspaceId: string;
    artifactId: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<{ storageKey: string }> {
    const storageKey = `${input.workspaceId}/${input.artifactId}/content`;
    this.#objects.set(storageKey, {
      bytes: new Uint8Array(input.bytes),
      contentType: input.contentType,
    });
    return { storageKey };
  }
  async head(storageKey: string) {
    const value = this.#objects.get(storageKey);
    return value
      ? {
          exists: true,
          sizeBytes: value.bytes.byteLength,
          contentType: value.contentType,
        }
      : { exists: false };
  }
  async read(storageKey: string, maxBytes: number): Promise<Uint8Array> {
    const value = this.#objects.get(storageKey);
    if (!value) throw new Error("Artifact object is unavailable.");
    if (value.bytes.byteLength > maxBytes)
      throw new Error("Artifact object exceeds the read limit.");
    return new Uint8Array(value.bytes);
  }
  async delete(storageKey: string): Promise<void> {
    this.#objects.delete(storageKey);
  }
  async verifyDeleted(storageKey: string): Promise<boolean> {
    return !this.#objects.has(storageKey);
  }
}

export class BoundedArtifactScanner implements ArtifactScanner {
  async scan(input: {
    bytes: Uint8Array;
    declaredMimeType: string;
    maxBytes: number;
  }): Promise<ArtifactScanResult> {
    if (input.bytes.byteLength > input.maxBytes)
      return {
        verdict: "malicious",
        scannerVersion: "bounded-v1",
        safeCode: "size_limit_exceeded",
      };
    const canary = new TextDecoder().decode(
      input.bytes.subarray(0, Math.min(input.bytes.byteLength, 8_192)),
    );
    if (/EICAR-STANDARD-ANTIVIRUS-TEST-FILE/iu.test(canary))
      return {
        verdict: "malicious",
        scannerVersion: "bounded-v1",
        safeCode: "malware_test_signature",
      };
    if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/iu.test(input.declaredMimeType))
      return {
        verdict: "unsupported",
        scannerVersion: "bounded-v1",
        safeCode: "invalid_mime_type",
      };
    return { verdict: "clean", scannerVersion: "bounded-v1" };
  }
}
