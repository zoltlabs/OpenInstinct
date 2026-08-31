import { describe, expect, it } from "vitest";
import { FakeBrowserProvider } from "@openinstinct/browser";
import {
  deleteProviderProfileByExactName,
  exactHttpsOrigin,
  newTakeoverToken,
} from "../src/lib/browser-service";

describe("browser enrollment safety", () => {
  it("accepts only normalized exact HTTPS origins", () => {
    expect(exactHttpsOrigin("https://example.com")).toBe("https://example.com");
    expect(exactHttpsOrigin("https://example.com:8443")).toBe(
      "https://example.com:8443",
    );
    for (const value of [
      "http://example.com",
      "https://example.com/path",
      "https://user:secret@example.com",
      "https://example.com?token=secret",
      "https://example.com/#fragment",
    ]) {
      expect(() => exactHttpsOrigin(value)).toThrow();
    }
  });

  it("creates one-time takeover material that stores only a hash", () => {
    const first = newTakeoverToken();
    const second = newTakeoverToken();
    expect(first.token).not.toBe(first.hash);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.token).not.toBe(second.token);
    expect(first.hash).not.toBe(second.hash);
  });

  it("reconciles a crash-stranded profile by exact deterministic name", async () => {
    const provider = new FakeBrowserProvider();
    const profile = await provider.createProfile({
      name: "openinstinct-11111111-1111-4111-8111-111111111111",
    });
    expect(
      await deleteProviderProfileByExactName(provider, profile.name ?? ""),
    ).toBe(true);
    expect((await provider.profileHealth(profile.id)).status).toBe("missing");
  });
});
