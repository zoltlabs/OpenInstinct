import { describe, expect, it } from "vitest";
import { browserInteractionSchema, FakeBrowserProvider } from "../src/index";

describe("BrowserProvider v2", () => {
  it("supports durable profile/session lifecycle without serializing takeover URLs", async () => {
    const provider = new FakeBrowserProvider();
    const profile = await provider.createProfile({ name: "canary" });
    const session = await provider.startSession({
      profileId: profile.id,
      purpose: "enrollment",
    });
    expect(JSON.stringify({ profile, session })).not.toContain(
      "takeover.example",
    );
    const takeover = await provider.takeover(session.id);
    expect(takeover.url).toMatch(/^https:/u);
    expect(takeover.expiresAt).toBe(session.expiresAt);
    expect(
      (await provider.verifyAuthentication(session.id, "https://example.test"))
        .verified,
    ).toBe(true);
    expect((await provider.reconnectSession(session.id)).profileId).toBe(
      profile.id,
    );
    expect((await provider.checkpointSession(session.id)).checkpointed).toBe(
      true,
    );
    await provider.closeSession(session.id);
    expect((await provider.sessionHealth(session.id)).healthy).toBe(false);
    expect((await provider.deleteProfile(profile.id)).verified).toBe(true);
  });

  it("accepts one bounded typed action and rejects arbitrary code", () => {
    expect(
      browserInteractionSchema.safeParse({ type: "click", selector: "#ok" })
        .success,
    ).toBe(true);
    expect(
      browserInteractionSchema.safeParse({
        type: "evaluate",
        code: "process.exit()",
      }).success,
    ).toBe(false);
    expect(
      browserInteractionSchema.safeParse({ type: "wait", milliseconds: 60_000 })
        .success,
    ).toBe(false);
  });

  it("bounds file transfer through the provider contract", async () => {
    const provider = new FakeBrowserProvider();
    const session = await provider.startSession({ purpose: "automation" });
    const file = {
      name: "report.txt",
      mimeType: "text/plain",
      bytes: new Uint8Array([1, 2]),
    };
    const uploaded = await provider.uploadFile(session.id, file);
    expect(
      await provider.downloadFile(session.id, uploaded.remotePath, 2),
    ).toEqual(file);
    await expect(
      provider.downloadFile(session.id, uploaded.remotePath, 1),
    ).rejects.toThrow();
  });
});
