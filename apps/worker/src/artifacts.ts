import {
  artifactSha256,
  type ArtifactByteStore,
  type ArtifactKind,
  type ArtifactScanner,
  type ArtifactSensitivity,
} from "@openinstinct/artifacts";
import type { OpenInstinctStore } from "@openinstinct/db";
import { createHash, randomUUID } from "node:crypto";

export class ArtifactLifecycleService {
  constructor(
    private readonly store: OpenInstinctStore,
    private readonly bytes: ArtifactByteStore,
    private readonly scanner: ArtifactScanner,
  ) {}

  async ingest(input: {
    workspaceId: string;
    browserExecutionId?: string;
    stepId?: string;
    kind: ArtifactKind;
    sensitivity: ArtifactSensitivity;
    displayName: string;
    contentType: string;
    bytes: Uint8Array;
    maxBytes?: number;
    artifactId?: string;
    redactionStatus?: "redacted" | "withheld" | "not_applicable";
    redactionVersion?: string;
  }): Promise<{ artifactId: string; verdict: string }> {
    const maxBytes = Math.min(input.maxBytes ?? 25_000_000, 25_000_000);
    if (input.bytes.byteLength > maxBytes)
      throw new Error("Artifact exceeds the ingestion size limit.");
    const artifactId = input.artifactId ?? randomUUID();
    const uploadToken = randomUUID();
    const reservation = await this.store.reserveArtifact({
      id: artifactId,
      workspaceId: input.workspaceId,
      browserExecutionId: input.browserExecutionId,
      stepId: input.stepId,
      kind: input.kind,
      sensitivity: input.sensitivity,
      displayName: input.displayName,
      declaredMimeType: input.contentType,
      uploadToken,
    });
    if (reservation === "available") return { artifactId, verdict: "clean" };
    if (reservation === "rejected") return { artifactId, verdict: "rejected" };
    const expectedStorageKey = `${input.workspaceId}/${artifactId}/content`;
    const existing = await this.bytes.head(expectedStorageKey);
    const uploaded: { storageKey: string; etag?: string } = existing.exists
      ? await this.verifyExistingObject(
          expectedStorageKey,
          input.bytes,
          input.contentType,
          maxBytes,
        )
      : await this.bytes.put({
          workspaceId: input.workspaceId,
          artifactId,
          bytes: input.bytes,
          contentType: input.contentType,
        });
    await this.store.bindArtifactLocation({
      id: artifactId,
      workspaceId: input.workspaceId,
      bucketId: "openinstinct-quarantine",
      storageKey: uploaded.storageKey,
      etag: uploaded.etag,
      sizeBytes: input.bytes.byteLength,
      sha256: artifactSha256(input.bytes),
      uploadToken,
    });
    const result = await this.scanner.scan({
      bytes: input.bytes,
      declaredMimeType: input.contentType,
      maxBytes,
    });
    await this.store.completeArtifactScan({
      id: artifactId,
      workspaceId: input.workspaceId,
      result,
      detectedMimeType: input.contentType,
      redactionStatus:
        input.redactionStatus ??
        (input.kind === "screenshot" || input.kind === "dom"
          ? "withheld"
          : "not_applicable"),
      redactionVersion: input.redactionVersion,
    });
    return { artifactId, verdict: result.verdict };
  }

  private async verifyExistingObject(
    storageKey: string,
    expected: Uint8Array,
    contentType: string,
    maxBytes: number,
  ): Promise<{ storageKey: string }> {
    const actual = await this.bytes.read(storageKey, maxBytes);
    if (
      actual.byteLength !== expected.byteLength ||
      artifactSha256(actual) !== artifactSha256(expected)
    )
      throw new Error("Existing artifact object conflicts with the retry.");
    void contentType;
    return { storageKey };
  }

  async delete(input: {
    artifactId: string;
    workspaceId: string;
  }): Promise<{ verified: boolean }> {
    const location = await this.store.getArtifactLocationForDeletion({
      id: input.artifactId,
      workspaceId: input.workspaceId,
    });
    if (location.bucketId !== "openinstinct-quarantine")
      throw new Error(
        "Artifact byte store does not match its durable location.",
      );
    await this.bytes.delete(location.storageKey);
    const verified = await this.bytes.verifyDeleted(location.storageKey);
    await this.store.completeArtifactDeletion({
      id: input.artifactId,
      workspaceId: input.workspaceId,
      verified,
    });
    return { verified };
  }
}

export function deterministicArtifactId(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}
