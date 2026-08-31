import { describe, expect, it } from "vitest";
import {
  createActionRequest,
  isResultRetryable,
  payloadHash,
  resultCertaintySchema,
  structuredToolResultSchema,
} from "../src/index";

const certainties = [
  "succeeded",
  "failed_before_effect",
  "failed_after_reversible_effect",
  "unknown",
  "reconciled_succeeded",
  "reconciled_failed",
] as const;

describe("execution truth", () => {
  it("accepts exactly the supported certainty taxonomy", () => {
    for (const certainty of certainties)
      expect(resultCertaintySchema.parse(certainty)).toBe(certainty);
    expect(resultCertaintySchema.safeParse("maybe").success).toBe(false);
  });

  it("allows automatic retry only before any effect", () => {
    for (const certainty of certainties)
      expect(isResultRetryable(certainty)).toBe(
        certainty === "failed_before_effect",
      );
  });

  it("binds a bounded structured result to its exact output", () => {
    const output = { receiptId: "receipt-1", status: "created" };
    expect(
      structuredToolResultSchema.parse({
        id: "10000000-0000-4000-8000-000000000001",
        workspaceId: "10000000-0000-4000-8000-000000000002",
        runId: "10000000-0000-4000-8000-000000000003",
        stepId: "10000000-0000-4000-8000-000000000004",
        actionRequestId: "10000000-0000-4000-8000-000000000005",
        toolName: "test.create",
        certainty: "succeeded",
        attempt: 1,
        output,
        outputHash: payloadHash(output),
        retryEligible: false,
        startedAt: "2026-08-31T12:00:00.000Z",
        completedAt: "2026-08-31T12:00:01.000Z",
      }).output,
    ).toEqual(output);
  });

  it("rejects a mismatched hash or retry flag", () => {
    const base = {
      id: "10000000-0000-4000-8000-000000000001",
      workspaceId: "10000000-0000-4000-8000-000000000002",
      runId: "10000000-0000-4000-8000-000000000003",
      stepId: "10000000-0000-4000-8000-000000000004",
      toolName: "test.create",
      certainty: "unknown" as const,
      attempt: 1,
      output: { ok: true },
      outputHash: "0".repeat(64),
      retryEligible: true,
      startedAt: "2026-08-31T12:00:00.000Z",
      completedAt: "2026-08-31T12:00:01.000Z",
    };
    expect(structuredToolResultSchema.safeParse(base).success).toBe(false);
  });

  it("rejects values that JSON persistence would otherwise rewrite", () => {
    for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n])
      expect(() => payloadHash(value)).toThrow(/JSON|serializable|finite/);
    expect(() =>
      createActionRequest({
        workspaceId: "10000000-0000-4000-8000-000000000002",
        runId: "10000000-0000-4000-8000-000000000003",
        toolName: "test.create",
        risk: "write",
        summary: "invalid",
        payload: { nested: undefined },
      }),
    ).toThrow(/JSON|serializable/);
  });
});
