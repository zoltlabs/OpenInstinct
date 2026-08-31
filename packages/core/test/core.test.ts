import { describe, expect, it } from "vitest";
import {
  actionRequestSchema,
  authorityGrantConfigurationVersion,
  createActionRequest,
  decideSemanticAction,
  deriveSemanticGuards,
  payloadHash,
  transitionRun,
} from "../src/index";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";

describe("core policy", () => {
  const communicationIntent = {
    version: 1 as const,
    effect: "send" as const,
    resource: { class: "message" },
    provider: "google",
    exactOrigin: "https://www.googleapis.com",
    recipients: [{ id: "person@example.com" }],
    reversibility: "irreversible" as const,
    commitPoint: true,
    credentialUse: "session" as const,
    postconditions: [],
  };
  it("uses stable hashes independent of object key order", () => {
    expect(payloadHash({ a: 1, b: 2 })).toBe(payloadHash({ b: 2, a: 1 }));
  });

  it("requires approval for communication", () => {
    expect(decideSemanticAction({ intent: communicationIntent }).type).toBe(
      "approval",
    );
  });

  it("denies financial and requires fresh destructive approval", () => {
    expect(
      decideSemanticAction({
        intent: {
          ...communicationIntent,
          effect: "purchase",
          resource: { class: "order" },
          recipients: [],
          amount: { currency: "USD", minorUnits: "100" },
          credentialUse: "payment",
        },
      }).type,
    ).toBe("deny");
    expect(
      decideSemanticAction({
        intent: {
          ...communicationIntent,
          effect: "delete",
          recipients: [],
        },
      }).type,
    ).toBe("approval");
  });

  it("binds action requests to their exact input", () => {
    const payload = { to: "person@example.com", body: "Hello" };
    const action = createActionRequest({
      workspaceId,
      runId,
      toolName: "gmail.send",
      risk: "communicate",
      summary: "Send a reply",
      payload,
      semanticIntent: communicationIntent,
      guardConditions: deriveSemanticGuards({
        intent: communicationIntent,
        payload,
      }),
    });
    expect(action.inputHash).toBe(payloadHash(action.input));
    expect(
      actionRequestSchema.safeParse({
        ...action,
        input: { ...action.input, body: "Changed" },
      }).success,
    ).toBe(false);
    expect(
      actionRequestSchema.safeParse({
        ...action,
        semanticIntent: {
          ...action.semanticIntent!,
          recipients: [{ id: "other@example.com" }],
        },
      }).success,
    ).toBe(false);
  });

  it("allows only an exact in-window bounded grant", () => {
    const configuration = {
      id: "00000000-0000-4000-8000-000000000010",
      workspaceId,
      version: 1,
      name: "Known recipient",
      effects: ["send" as const],
      resourceClasses: ["message"],
      providers: ["google"],
      origins: ["https://www.googleapis.com"],
      accountIds: [],
      counterpartyIds: [],
      recipientIds: ["person@example.com"],
      perActionLimit: null,
      rollingLimit: null,
      maxUses: 2,
      minimumIntervalSeconds: 60,
      quietHours: null,
      startsAt: "2026-08-31T00:00:00.000Z",
      expiresAt: "2026-09-02T00:00:00.000Z",
      revokedAt: null,
      alwaysRequireFreshApproval: false,
      alwaysRequireHumanTakeover: false,
    };
    const grant = {
      ...configuration,
      configurationVersion: authorityGrantConfigurationVersion(configuration),
    };
    expect(
      decideSemanticAction({
        intent: communicationIntent,
        grants: [{ grant, usage: { uses: 0 } }],
        now: new Date("2026-08-31T12:00:00.000Z"),
      }),
    ).toMatchObject({ type: "allow", authorityGrantId: grant.id });
    expect(
      decideSemanticAction({
        intent: {
          ...communicationIntent,
          recipients: [{ id: "other@example.com" }],
        },
        grants: [{ grant, usage: { uses: 0 } }],
        now: new Date("2026-08-31T12:00:00.000Z"),
      }).type,
    ).toBe("approval");
    expect(
      decideSemanticAction({
        intent: communicationIntent,
        grants: [
          {
            grant,
            usage: {
              uses: 1,
              lastUsedAt: "2026-08-31T11:59:30.000Z",
            },
          },
        ],
        now: new Date("2026-08-31T12:00:00.000Z"),
      }).type,
    ).toBe("approval");
  });

  it("fails closed for security credentials", () => {
    expect(
      decideSemanticAction({
        intent: {
          ...communicationIntent,
          effect: "security_change",
          recipients: [],
        },
      }).type,
    ).toBe("deny");
    expect(
      decideSemanticAction({
        intent: { ...communicationIntent, credentialUse: "otp" },
      }).type,
    ).toBe("handoff");
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
