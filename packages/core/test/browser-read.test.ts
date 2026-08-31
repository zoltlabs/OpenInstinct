import { describe, expect, it } from "vitest";
import {
  browserReadObservationHash,
  browserReadActionSchema,
  canonicalBrowserReadUrl,
  payloadHash,
  validateBrowserReadAction,
  type BrowserReadObservation,
} from "../src/index";

function observation(): BrowserReadObservation {
  const base = {
    id: "11111111-1111-4111-8111-111111111111",
    origin: "https://example.test",
    path: "/research",
    title: "Research",
    text: "A bounded page",
    links: [
      {
        text: "Next",
        href: "https://example.test/next",
        hrefHash: payloadHash("https://example.test/next"),
      },
    ],
    tabCount: 1,
    suspicious: false,
    redactionVersion: "browser-redaction-v1",
  };
  return {
    ...base,
    hash: browserReadObservationHash(base),
  };
}

describe("read-only browser policy", () => {
  it("rejects credential-bearing and non-HTTPS targets", () => {
    expect(() => canonicalBrowserReadUrl("http://example.test")).toThrow();
    expect(() =>
      canonicalBrowserReadUrl("https://example.test/?token=secret"),
    ).toThrow();
  });

  it("does not expose generic page-controlled navigation actions", () => {
    expect(() =>
      browserReadActionSchema.parse({
        type: "follow_link",
        linkIndex: 0,
        expectedHrefHash: payloadHash("changed"),
      }),
    ).toThrow();
  });

  it("fails closed on suspicious page content and exhausted budgets", () => {
    const current = { ...observation(), suspicious: true };
    expect(() =>
      validateBrowserReadAction({
        action: { type: "scroll", deltaY: 500 },
        observation: current,
        allowedOrigins: ["https://example.test"],
        remainingSteps: 1,
      }),
    ).toThrow();
    expect(() =>
      validateBrowserReadAction({
        action: { type: "wait", milliseconds: 100 },
        observation: observation(),
        allowedOrigins: ["https://example.test"],
        remainingSteps: 0,
      }),
    ).toThrow();
  });
});
