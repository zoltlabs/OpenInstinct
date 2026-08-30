import { describe, expect, it } from "vitest";
import { feedbackForCode, feedbackUrl } from "../src/lib/feedback";
import { isValidTimeZone } from "../src/lib/validation";

describe("control-plane feedback", () => {
  it("maps redirects to owner-visible messages without reflecting raw errors", () => {
    expect(feedbackForCode("check-email")).toMatchObject({ tone: "success" });
    expect(feedbackForCode("approval-recorded")).toMatchObject({
      tone: "success",
    });
    expect(feedbackForCode("auth-exchange-failed")?.message).toContain(
      "request a new one",
    );
    expect(feedbackForCode("unknown")).toBeUndefined();
  });

  it("builds same-origin feedback URLs", () => {
    expect(
      feedbackUrl(
        "https://assistant.example/api/auth/sign-in",
        "check-email",
      ).toString(),
    ).toBe("https://assistant.example/?feedback=check-email");
    expect(
      feedbackUrl(
        "https://assistant.example/api/approvals/action-1",
        "approval-failed",
        "/approvals/action-1",
      ).toString(),
    ).toBe(
      "https://assistant.example/approvals/action-1?feedback=approval-failed",
    );
  });

  it("validates IANA time zones", () => {
    expect(isValidTimeZone("America/Mexico_City")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mexico City-ish")).toBe(false);
  });
});
