import {
  BoundedArtifactScanner,
  InMemoryArtifactByteStore,
} from "@openinstinct/artifacts";
import { describe, expect, it, vi } from "vitest";
import { ArtifactLifecycleService } from "../src/artifacts";

describe("ArtifactLifecycleService", () => {
  it("quarantines and scans immutable bytes before publishing metadata", async () => {
    const store = {
      reserveArtifact: vi.fn(),
      bindArtifactLocation: vi.fn(),
      completeArtifactScan: vi.fn(),
    };
    const service = new ArtifactLifecycleService(
      store as never,
      new InMemoryArtifactByteStore(),
      new BoundedArtifactScanner(),
    );
    const result = await service.ingest({
      workspaceId: "10000000-0000-4000-8000-000000000001",
      kind: "receipt",
      sensitivity: "personal",
      displayName: "receipt.txt",
      contentType: "text/plain",
      bytes: new TextEncoder().encode("safe receipt"),
    });
    expect(result.verdict).toBe("clean");
    expect(store.bindArtifactLocation).toHaveBeenCalledWith(
      expect.objectContaining({ bucketId: "openinstinct-quarantine" }),
    );
    expect(store.completeArtifactScan).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({ verdict: "clean" }),
      }),
    );
  });

  it("rejects malicious bytes and never reports them clean", async () => {
    const store = {
      reserveArtifact: vi.fn(),
      bindArtifactLocation: vi.fn(),
      completeArtifactScan: vi.fn(),
    };
    const result = await new ArtifactLifecycleService(
      store as never,
      new InMemoryArtifactByteStore(),
      new BoundedArtifactScanner(),
    ).ingest({
      workspaceId: "10000000-0000-4000-8000-000000000001",
      kind: "download",
      sensitivity: "sensitive",
      displayName: "sample.txt",
      contentType: "text/plain",
      bytes: new TextEncoder().encode("EICAR-STANDARD-ANTIVIRUS-TEST-FILE"),
    });
    expect(result.verdict).toBe("malicious");
    expect(store.completeArtifactScan).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({ verdict: "malicious" }),
      }),
    );
  });
});
