import { describe, expect, it } from "vitest";
import { browserActionProgram, browserActionSchema } from "../src/index";

describe("bounded browser actions", () => {
  it("accepts only the supported step language", () => {
    const action = browserActionSchema.parse({
      startUrl: "https://example.com",
      steps: [
        { action: "fill", selector: "#query", value: "OpenInstinct" },
        { action: "click", selector: "button[type=submit]" },
      ],
    });
    expect(browserActionProgram(action)).toContain("page.locator");
    expect(
      browserActionSchema.safeParse({
        startUrl: "https://example.com",
        steps: [{ action: "evaluate", code: "process.exit()" }],
      }).success,
    ).toBe(false);
  });

  it("bounds action count and wait duration", () => {
    expect(
      browserActionSchema.safeParse({
        startUrl: "https://example.com",
        steps: [{ action: "wait", milliseconds: 60_000 }],
      }).success,
    ).toBe(false);
  });
});
