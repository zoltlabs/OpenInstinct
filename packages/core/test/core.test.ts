import { describe, expect, it } from "vitest";
import {
  createActionRequest,
  decideAction,
  payloadHash,
  transitionRun,
} from "../src/index";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";

describe("core policy", () => {
  it("uses stable hashes independent of object key order", () => {
    expect(payloadHash({ a: 1, b: 2 })).toBe(payloadHash({ b: 2, a: 1 }));
  });

  it("requires approval for communication", () => {
    expect(
      decideAction({ risk: "communicate", toolName: "gmail.send" }).type,
    ).toBe("approval");
  });

  it("denies financial and destructive operations", () => {
    expect(decideAction({ risk: "financial", toolName: "pay" }).type).toBe(
      "deny",
    );
    expect(decideAction({ risk: "destructive", toolName: "delete" }).type).toBe(
      "approval",
    );
  });

  it("binds action requests to their exact input", () => {
    const action = createActionRequest({
      workspaceId,
      runId,
      toolName: "gmail.send",
      risk: "communicate",
      summary: "Send a reply",
      payload: { to: "person@example.com", body: "Hello" },
    });
    expect(action.inputHash).toBe(payloadHash(action.input));
  });
});

describe("run state", () => {
  it("allows durable wait and resume transitions", () => {
    const running = transitionRun(
      { id: runId, workspaceId, status: "queued", attempt: 0 },
      "running",
    );
    const waiting = transitionRun(running, "waiting_approval", {
      waitingFor: "action-1",
    });
    expect(transitionRun(waiting, "queued").status).toBe("queued");
  });

  it("allows durable continuation and failed-job retry claims", () => {
    const running = {
      id: runId,
      workspaceId,
      status: "running" as const,
      attempt: 1,
    };
    expect(transitionRun(running, "queued").status).toBe("queued");
    expect(
      transitionRun({ ...running, status: "failed" }, "running").status,
    ).toBe("running");
  });

  it("rejects terminal transitions", () => {
    expect(() =>
      transitionRun(
        { id: runId, workspaceId, status: "completed", attempt: 1 },
        "running",
      ),
    ).toThrow(/Invalid run transition/);
  });
});
