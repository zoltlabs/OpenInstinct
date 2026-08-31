import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { AiBrowserReadPlanner } from "../src/browser-planner";

describe("AiBrowserReadPlanner", () => {
  it("parses one structured decision from a bounded redacted observation", async () => {
    const planner = new AiBrowserReadPlanner(
      new MockLanguageModelV4({
        doGenerate: async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                type: "finish",
                summary: "The public page provides the requested evidence.",
              }),
            },
          ],
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: {
              total: 10,
              noCache: 10,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: {
              total: 10,
              text: 10,
              reasoning: undefined,
            },
          },
          warnings: [],
        }),
      }),
    );
    await expect(
      planner.decide({
        goal: "Read the page",
        allowedOrigins: ["https://example.test"],
        remainingSteps: 2,
        observation: {
          id: "10000000-0000-4000-8000-000000000001",
          hash: "a".repeat(64),
          origin: "https://example.test",
          path: "/",
          title: "Example",
          text: "Public evidence",
          links: [],
          tabCount: 1,
          suspicious: false,
          redactionVersion: "semantic-v1",
        },
      }),
    ).resolves.toEqual({
      type: "finish",
      summary: "The public page provides the requested evidence.",
    });
  });
});
