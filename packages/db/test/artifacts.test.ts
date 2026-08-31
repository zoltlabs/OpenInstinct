import { describe, expect, it, vi } from "vitest";
import { SupabaseArtifactByteStore } from "../src/artifacts";

describe("SupabaseArtifactByteStore", () => {
  it("rejects storage paths outside a workspace/artifact namespace", async () => {
    const store = new SupabaseArtifactByteStore({
      supabaseUrl: "https://example.test",
      serviceRoleKey: "test-only-placeholder",
      client: {} as never,
    });
    await expect(store.verifyDeleted("../secret")).rejects.toThrow(
      "outside the bounded workspace path",
    );
  });

  it("uploads immutable bytes into quarantine by default", async () => {
    const upload = vi.fn().mockResolvedValue({
      data: {
        path: "10000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000002/content",
      },
      error: null,
    });
    const from = vi.fn().mockReturnValue({ upload });
    const store = new SupabaseArtifactByteStore({
      supabaseUrl: "https://example.test",
      serviceRoleKey: "test-only-placeholder",
      client: { storage: { from } } as never,
    });
    await store.put({
      workspaceId: "10000000-0000-4000-8000-000000000001",
      artifactId: "10000000-0000-4000-8000-000000000002",
      bytes: new Uint8Array([1]),
      contentType: "text/plain",
    });
    expect(from).toHaveBeenCalledWith("openinstinct-quarantine");
    expect(upload).toHaveBeenCalledWith(
      "10000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000002/content",
      expect.any(Uint8Array),
      { cacheControl: "no-store", contentType: "text/plain", upsert: false },
    );
  });
});
