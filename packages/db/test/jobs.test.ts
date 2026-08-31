import { describe, expect, it } from "vitest";
import { agentJobSchema } from "../src/jobs";

describe("scheduled jobs", () => {
  it("validates bounded reminder deliveries", () => {
    expect(
      agentJobSchema.safeParse({
        type: "deliver_reminder",
        triggerId: "7e5e8b22-8e72-4ec1-a81f-e804d8c1fc01",
        occurrenceAt: "2026-08-28T12:00:00.000Z",
        workspaceId: "7e5e8b22-8e72-4ec1-a81f-e804d8c1fc02",
        conversationId: "7e5e8b22-8e72-4ec1-a81f-e804d8c1fc03",
        message: "Check the oven",
      }).success,
    ).toBe(true);
  });

  it("validates result continuations using stable identifiers only", () => {
    expect(
      agentJobSchema.parse({
        type: "continue_run",
        runId: "7e5e8b22-8e72-4ec1-a81f-e804d8c1fc01",
        workspaceId: "7e5e8b22-8e72-4ec1-a81f-e804d8c1fc02",
        toolResultId: "7e5e8b22-8e72-4ec1-a81f-e804d8c1fc03",
      }),
    ).not.toHaveProperty("output");
  });

  it("validates read-only reconciliation jobs without executable payloads", () => {
    expect(
      agentJobSchema.parse({
        type: "reconcile_action",
        caseId: "7e5e8b22-8e72-4ec1-a81f-e804d8c1fc01",
        workspaceId: "7e5e8b22-8e72-4ec1-a81f-e804d8c1fc02",
      }),
    ).toEqual({
      type: "reconcile_action",
      caseId: "7e5e8b22-8e72-4ec1-a81f-e804d8c1fc01",
      workspaceId: "7e5e8b22-8e72-4ec1-a81f-e804d8c1fc02",
    });
  });
});
