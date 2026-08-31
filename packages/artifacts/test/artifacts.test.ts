import { describe, expect, it } from "vitest";
import {
  artifactSha256,
  BoundedArtifactScanner,
  InMemoryArtifactByteStore,
  sanitizedArtifactName,
} from "../src/index";

describe("artifact contracts", () => {
  it("stores bounded bytes by opaque server key and verifies deletion", async () => {
    const store = new InMemoryArtifactByteStore();
    const bytes = new TextEncoder().encode("redacted");
    const stored = await store.put({
      workspaceId: "workspace",
      artifactId: "artifact",
      bytes,
      contentType: "text/plain",
    });
    expect(await store.read(stored.storageKey, 100)).toEqual(bytes);
    expect(artifactSha256(bytes)).toMatch(/^[0-9a-f]{64}$/u);
    await store.delete(stored.storageKey);
    expect(await store.verifyDeleted(stored.storageKey)).toBe(true);
  });

  it("quarantines oversized and malicious files", async () => {
    const scanner = new BoundedArtifactScanner();
    expect(
      (
        await scanner.scan({
          bytes: new Uint8Array(11),
          declaredMimeType: "text/plain",
          maxBytes: 10,
        })
      ).verdict,
    ).toBe("malicious");
    expect(
      (
        await scanner.scan({
          bytes: new TextEncoder().encode("EICAR-STANDARD-ANTIVIRUS-TEST-FILE"),
          declaredMimeType: "text/plain",
          maxBytes: 100,
        })
      ).safeCode,
    ).toBe("malware_test_signature");
  });

  it("sanitizes display names", () => {
    expect(sanitizedArtifactName("../report?.txt")).toBe("__report_.txt");
    expect(sanitizedArtifactName("..")).toBe("_");
  });
});
