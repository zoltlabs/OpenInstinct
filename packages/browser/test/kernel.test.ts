import { describe, expect, it, vi } from "vitest";
import { KernelBrowserProvider } from "../src/index";

describe("Kernel browser safety adapter", () => {
  it("does not mistake an exact-origin page for proof of authentication", async () => {
    const execute = vi.fn().mockResolvedValue({
      success: true,
      result: {
        url: "https://example.test/login",
        title: "Sign in",
        text: "Please sign in",
        links: [],
      },
    });
    const provider = new KernelBrowserProvider("unused-test-key", {
      browsers: { playwright: { execute } },
    } as never);
    const verification = await provider.verifyAuthentication(
      "session-id",
      "https://example.test",
    );
    expect(verification.verified).toBe(false);
    expect(verification.method).toBe(
      "unsupported_generic_kernel_profile_check",
    );
  });

  it("reports the provider session deadline instead of fabricating a TTL", async () => {
    const provider = new KernelBrowserProvider("unused-test-key", {
      browsers: {
        retrieve: vi.fn().mockResolvedValue({
          session_id: "session-id",
          created_at: "2026-08-31T00:00:00.000Z",
          timeout_seconds: 900,
          browser_live_view_url: "https://live.example.test/capability",
        }),
      },
    } as never);
    expect((await provider.takeover("session-id")).expiresAt).toBe(
      "2026-08-31T00:15:00.000Z",
    );
  });
});
