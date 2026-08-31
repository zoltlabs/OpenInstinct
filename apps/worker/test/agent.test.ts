import { describe, expect, it } from "vitest";
import { modelSafeExecutionResults } from "../src/agent";

describe("execution-result model context", () => {
  it("enforces a real aggregate serialization ceiling", () => {
    const serialized = modelSafeExecutionResults([
      {
        id: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        runId: "33333333-3333-4333-8333-333333333333",
        stepId: "44444444-4444-4444-8444-444444444444",
        toolName: "memory.save",
        certainty: "succeeded",
        attempt: 1,
        output: { content: "x".repeat(120_000) },
        outputHash: "a".repeat(64),
        retryEligible: false,
        startedAt: "2026-08-31T10:00:00.000Z",
        completedAt: "2026-08-31T10:00:01.000Z",
      },
    ]);

    expect(serialized.length).toBeLessThanOrEqual(20_000);
    expect(() => JSON.parse(serialized)).not.toThrow();
  });
});
