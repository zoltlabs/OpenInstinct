import { artifactSha256 } from "@openinstinct/artifacts";
import {
  redactBrowserObservation,
  type BrowserInteraction,
  type BrowserProvider,
} from "@openinstinct/browser";
import {
  payloadHash,
  validateBrowserReadAction,
  validateBrowserReadTarget,
  type BrowserReadAction,
  type BrowserReadDecision,
  type BrowserReadObservation,
} from "@openinstinct/core";
import { OpenInstinctStore } from "@openinstinct/db";
import type { BrowserReadPlanner } from "./browser-planner";
import {
  deterministicArtifactId,
  type ArtifactLifecycleService,
} from "./artifacts";
import { randomUUID } from "node:crypto";

export class BrowserResearchRuntime {
  constructor(
    private readonly store: OpenInstinctStore,
    private readonly browser: BrowserProvider,
    private readonly planner: BrowserReadPlanner,
    private readonly artifacts?: ArtifactLifecycleService,
  ) {}

  async processSlice(input: {
    executionId: string;
    workspaceId: string;
    claimToken: string;
  }): Promise<{ handoffId?: string }> {
    const claimed = await this.store.claimBrowserExecutionSlice({
      ...input,
      leaseSeconds: 120,
    });
    if (!claimed) return {};
    const capabilities = await this.browser.capabilities();
    if (
      claimed.mode === "persistent_read_only" &&
      !capabilities.networkReadOnlyIsolation
    ) {
      const sessionId = await this.ensureTakeoverSession(
        claimed,
        input.claimToken,
      );
      const handoffId = await this.requestHandoff(
        claimed,
        input.claimToken,
        {
          type: "request_owner_takeover",
          reason:
            "Provider cannot prove complete read-only isolation for an authenticated profile.",
        },
        "provider_read_only_isolation_unavailable",
        sessionId,
      );
      return { handoffId };
    }
    if (Date.now() >= new Date(claimed.deadlineAt).getTime()) {
      await this.abortBeforeObservation(
        claimed,
        input.claimToken,
        { type: "finish", summary: "Browser research deadline was reached." },
        "browser_deadline_exceeded",
      );
      return {};
    }
    if (claimed.remainingCostUnits <= 0) {
      await this.abortBeforeObservation(
        claimed,
        input.claimToken,
        {
          type: "finish",
          summary: "Browser provider cost budget was reached.",
        },
        "browser_cost_budget_exhausted",
      );
      return {};
    }
    let sessionId: string | undefined;
    let observation: BrowserReadObservation;
    try {
      sessionId = await this.ensureSession(claimed, input.claimToken);
      const initial = await this.browser.observe(sessionId);
      if (initial.url === "about:blank") {
        validateBrowserReadTarget({
          url: claimed.startUrl,
          allowedOrigins: claimed.allowedOrigins,
        });
        const bootstrapHash = payloadHash({
          type: "trusted_bootstrap",
          url: claimed.startUrl,
        });
        await this.store.markBrowserBootstrapInvocationStarted({
          executionId: claimed.executionId,
          workspaceId: claimed.workspaceId,
          sliceId: claimed.sliceId,
          claimToken: input.claimToken,
          leaseEpoch: claimed.leaseEpoch,
          actionHash: bootstrapHash,
        });
        let bootstrapResult: Awaited<
          ReturnType<BrowserProvider["executeAction"]>
        >;
        try {
          bootstrapResult = await this.browser.executeAction(sessionId, {
            type: "navigate",
            url: claimed.startUrl,
          });
        } catch (error) {
          await this.store.markBrowserSliceInvocationUnknown({
            executionId: claimed.executionId,
            workspaceId: claimed.workspaceId,
            sliceId: claimed.sliceId,
            claimToken: input.claimToken,
            leaseEpoch: claimed.leaseEpoch,
            errorCode: "provider_bootstrap_outcome_unknown",
          });
          throw error;
        }
        await this.store.completeBrowserBootstrapInvocation({
          executionId: claimed.executionId,
          workspaceId: claimed.workspaceId,
          sliceId: claimed.sliceId,
          claimToken: input.claimToken,
          leaseEpoch: claimed.leaseEpoch,
          actionHash: bootstrapHash,
          resultHash: payloadHash(bootstrapResult),
        });
      }
      const rawObservation = await this.browser.observe(sessionId);
      validateBrowserReadTarget({
        url: rawObservation.url,
        allowedOrigins: claimed.allowedOrigins,
      });
      const screenshot =
        await this.browser.captureRedactedScreenshot(sessionId);
      let screenshotHash: string | undefined;
      let screenshotOmittedReason = screenshot.omittedReason;
      if (screenshot.bytes && this.artifacts) {
        screenshotHash = artifactSha256(screenshot.bytes);
        const artifact = await this.artifacts.ingest({
          workspaceId: claimed.workspaceId,
          browserExecutionId: claimed.executionId,
          stepId: claimed.stepId,
          kind: "screenshot",
          sensitivity: "sensitive",
          displayName: `browser-${claimed.ordinal}.png`,
          contentType: "image/png",
          bytes: screenshot.bytes,
          maxBytes: 10_000_000,
          artifactId: deterministicArtifactId(
            `${claimed.executionId}:${claimed.ordinal}:screenshot`,
          ),
          redactionStatus: "redacted",
          redactionVersion: screenshot.redactionVersion,
        });
        if (artifact.verdict !== "clean") {
          screenshotHash = undefined;
          screenshotOmittedReason = "screenshot_scan_rejected";
        }
      } else if (screenshot.bytes) {
        screenshotOmittedReason = "artifact_store_unavailable";
      }
      observation = redactBrowserObservation(rawObservation, {
        hash: screenshotHash,
        omittedReason: screenshotOmittedReason,
      });
      await this.store.recordBrowserSliceObservation({
        executionId: claimed.executionId,
        workspaceId: input.workspaceId,
        sliceId: claimed.sliceId,
        claimToken: input.claimToken,
        leaseEpoch: claimed.leaseEpoch,
        observation,
      });
    } catch (error) {
      await this.store.requestBrowserExecutionCleanup({
        executionId: claimed.executionId,
        workspaceId: claimed.workspaceId,
        sliceId: claimed.sliceId,
        claimToken: input.claimToken,
        leaseEpoch: claimed.leaseEpoch,
        errorCode: "browser_observation_failed",
      });
      throw error;
    }
    if (observation.suspicious) {
      const handoffId = await this.requestHandoff(
        claimed,
        input.claimToken,
        {
          type: "request_owner_takeover",
          reason:
            "The page contains suspicious instructions or a credential request.",
        },
        "suspicious_browser_content",
        sessionId,
      );
      return { handoffId };
    }
    await this.store.renewBrowserExecutionLease({
      executionId: claimed.executionId,
      workspaceId: claimed.workspaceId,
      claimToken: input.claimToken,
      leaseEpoch: claimed.leaseEpoch,
      leaseSeconds: 120,
    });
    const decision = await this.planner.decide({
      goal: claimed.goal,
      observation,
      allowedOrigins: claimed.allowedOrigins,
      remainingSteps: claimed.remainingSteps,
    });
    if (decision.type !== "act") {
      if (decision.type === "request_owner_takeover") {
        const handoffId = await this.requestHandoff(
          claimed,
          input.claimToken,
          decision,
          "owner_takeover_required",
          sessionId,
        );
        return { handoffId };
      }
      await this.finishSafely(
        claimed,
        input.claimToken,
        decision,
        undefined,
        sessionId,
      );
      return {};
    }
    const action = validateBrowserReadAction({
      action: decision.action,
      observation,
      allowedOrigins: claimed.allowedOrigins,
      remainingSteps: claimed.remainingSteps,
    });
    const providerAction = toProviderAction(action, observation);
    await this.store.validateBrowserSliceAction({
      executionId: claimed.executionId,
      workspaceId: claimed.workspaceId,
      sliceId: claimed.sliceId,
      claimToken: input.claimToken,
      leaseEpoch: claimed.leaseEpoch,
      decision,
      actionHash: payloadHash(action),
    });
    await this.store.renewBrowserExecutionLease({
      executionId: claimed.executionId,
      workspaceId: claimed.workspaceId,
      claimToken: input.claimToken,
      leaseEpoch: claimed.leaseEpoch,
      leaseSeconds: 120,
    });
    await this.store.markBrowserSliceInvocationStarted({
      executionId: claimed.executionId,
      workspaceId: claimed.workspaceId,
      sliceId: claimed.sliceId,
      claimToken: input.claimToken,
      leaseEpoch: claimed.leaseEpoch,
      actionHash: payloadHash(action),
    });
    let result: Awaited<ReturnType<BrowserProvider["executeAction"]>>;
    try {
      result = await this.browser.executeAction(sessionId, providerAction);
    } catch (error) {
      await this.store.markBrowserSliceInvocationUnknown({
        executionId: claimed.executionId,
        workspaceId: claimed.workspaceId,
        sliceId: claimed.sliceId,
        claimToken: input.claimToken,
        leaseEpoch: claimed.leaseEpoch,
        errorCode: "provider_action_outcome_unknown",
      });
      throw error;
    }
    const completed = await this.store.completeBrowserExecutionSlice({
      executionId: claimed.executionId,
      workspaceId: input.workspaceId,
      sliceId: claimed.sliceId,
      claimToken: input.claimToken,
      leaseEpoch: claimed.leaseEpoch,
      decision,
      actionHash: payloadHash(action),
      resultHash: payloadHash(result),
    });
    if (completed.exhausted)
      await this.finishAfterCompletedSlice(
        claimed,
        input.claimToken,
        sessionId,
        "browser_step_budget_exhausted",
      );
    return {};
  }

  async requestHandoff(
    claimed: NonNullable<
      Awaited<ReturnType<OpenInstinctStore["claimBrowserExecutionSlice"]>>
    >,
    claimToken: string,
    decision: Extract<BrowserReadDecision, { type: "request_owner_takeover" }>,
    reasonCode: string,
    sessionId: string,
  ): Promise<string> {
    const handoffId = randomUUID();
    await this.store.requestBrowserExecutionHandoff({
      handoffId,
      executionId: claimed.executionId,
      workspaceId: claimed.workspaceId,
      sliceId: claimed.sliceId,
      claimToken,
      leaseEpoch: claimed.leaseEpoch,
      decision,
      providerSessionId: sessionId,
      reasonCode,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    return handoffId;
  }

  async processCleanup(input: {
    executionId: string;
    workspaceId: string;
    claimToken: string;
  }): Promise<void> {
    const claimed = await this.store.claimBrowserExecutionCleanup({
      ...input,
      leaseSeconds: 120,
    });
    if (!claimed) return;
    const sessions = await this.browser.findSessions({
      correlationId: claimed.correlationId,
      includeClosed: true,
    });
    const sessionIds = new Set(sessions.map((session) => session.id));
    if (claimed.providerSessionId) sessionIds.add(claimed.providerSessionId);
    for (const sessionId of sessionIds) {
      await this.browser.closeSession(sessionId);
      const health = await this.browser.sessionHealth(sessionId);
      if (health.healthy || !["closed", "missing"].includes(health.status))
        throw new Error("Provider browser cleanup remains unverified.");
    }
    await this.store.markBrowserExecutionSessionDeleted({
      executionId: claimed.executionId,
      workspaceId: claimed.workspaceId,
      claimToken: input.claimToken,
      leaseEpoch: claimed.leaseEpoch,
    });
    await this.store.finishBrowserExecution({
      executionId: claimed.executionId,
      workspaceId: claimed.workspaceId,
      claimToken: input.claimToken,
      leaseEpoch: claimed.leaseEpoch,
      ...(claimed.summary ? { summary: claimed.summary } : {}),
      ...(claimed.errorCode ? { errorCode: claimed.errorCode } : {}),
      unknown: claimed.unknown,
    });
  }

  async ensureSession(
    claimed: NonNullable<
      Awaited<ReturnType<OpenInstinctStore["claimBrowserExecutionSlice"]>>
    >,
    claimToken: string,
  ): Promise<string> {
    let session = claimed.providerSessionId
      ? await this.browser.reconnectSession(claimed.providerSessionId)
      : undefined;
    if (!session) {
      const recovered = await this.browser.findSessions({
        correlationId: claimed.correlationId,
      });
      if (recovered.length > 1)
        throw new Error(
          "Multiple provider sessions match one browser execution.",
        );
      session =
        recovered[0] ??
        (await this.browser.startSession({
          startUrl: claimed.startUrl,
          profileId: claimed.providerProfileId,
          timeoutSeconds: 600,
          purpose: "automation",
          correlationId: claimed.correlationId,
          readOnly: true,
        }));
    }
    const guards = await this.browser.installReadOnlyGuards(
      session.id,
      claimed.allowedOrigins,
    );
    if (!guards.installed) {
      await this.browser.closeSession(session.id);
      throw new Error("Provider read-only guards were not installed.");
    }
    if (claimed.mode === "persistent_read_only" && !guards.fullyIsolated) {
      await this.browser.closeSession(session.id);
      throw new Error(
        "Provider did not prove read-only isolation for the persistent profile.",
      );
    }
    await this.store.bindBrowserExecutionSession({
      executionId: claimed.executionId,
      workspaceId: claimed.workspaceId,
      claimToken,
      leaseEpoch: claimed.leaseEpoch,
      providerSessionId: session.id,
      sessionExpiresAt: session.expiresAt,
      guardsInstalled: true,
    });
    return session.id;
  }

  async ensureTakeoverSession(
    claimed: NonNullable<
      Awaited<ReturnType<OpenInstinctStore["claimBrowserExecutionSlice"]>>
    >,
    claimToken: string,
  ): Promise<string> {
    let session = claimed.providerSessionId
      ? await this.browser.reconnectSession(claimed.providerSessionId)
      : undefined;
    if (!session) {
      const matches = await this.browser.findSessions({
        correlationId: claimed.correlationId,
      });
      if (matches.length > 1)
        throw new Error(
          "Multiple provider sessions match one browser execution.",
        );
      session =
        matches[0] ??
        (await this.browser.startSession({
          profileId: claimed.providerProfileId,
          startUrl: claimed.startUrl,
          timeoutSeconds: 600,
          purpose: "takeover",
          correlationId: claimed.correlationId,
          readOnly: false,
        }));
    }
    await this.store.bindBrowserExecutionSession({
      executionId: claimed.executionId,
      workspaceId: claimed.workspaceId,
      claimToken,
      leaseEpoch: claimed.leaseEpoch,
      providerSessionId: session.id,
      sessionExpiresAt: session.expiresAt,
      guardsInstalled: false,
    });
    return session.id;
  }

  async finishSafely(
    claimed: NonNullable<
      Awaited<ReturnType<OpenInstinctStore["claimBrowserExecutionSlice"]>>
    >,
    claimToken: string,
    decision: Exclude<BrowserReadDecision, { type: "act" }>,
    errorCode?: string,
    sessionId?: string,
  ): Promise<void> {
    await this.store.completeBrowserExecutionSlice({
      executionId: claimed.executionId,
      workspaceId: claimed.workspaceId,
      sliceId: claimed.sliceId,
      claimToken,
      leaseEpoch: claimed.leaseEpoch,
      decision,
    });
    if (sessionId)
      await this.closeAndMarkDeleted(claimed, sessionId, claimToken);
    else
      await this.store.markBrowserExecutionSessionDeleted({
        executionId: claimed.executionId,
        workspaceId: claimed.workspaceId,
        claimToken,
        leaseEpoch: claimed.leaseEpoch,
      });
    await this.store.finishBrowserExecution({
      executionId: claimed.executionId,
      workspaceId: claimed.workspaceId,
      claimToken,
      leaseEpoch: claimed.leaseEpoch,
      ...(decision.type === "finish" ? { summary: decision.summary } : {}),
      ...(errorCode ? { errorCode } : {}),
    });
  }

  async finishAfterCompletedSlice(
    claimed: NonNullable<
      Awaited<ReturnType<OpenInstinctStore["claimBrowserExecutionSlice"]>>
    >,
    claimToken: string,
    sessionId: string,
    errorCode: string,
  ): Promise<void> {
    await this.closeAndMarkDeleted(claimed, sessionId, claimToken);
    await this.store.finishBrowserExecution({
      executionId: claimed.executionId,
      workspaceId: claimed.workspaceId,
      claimToken,
      leaseEpoch: claimed.leaseEpoch,
      errorCode,
    });
  }

  async abortBeforeObservation(
    claimed: NonNullable<
      Awaited<ReturnType<OpenInstinctStore["claimBrowserExecutionSlice"]>>
    >,
    claimToken: string,
    decision: Exclude<BrowserReadDecision, { type: "act" }>,
    errorCode: string,
  ): Promise<void> {
    await this.store.abortBrowserExecutionSlice({
      executionId: claimed.executionId,
      workspaceId: claimed.workspaceId,
      sliceId: claimed.sliceId,
      claimToken,
      leaseEpoch: claimed.leaseEpoch,
      decision,
      errorCode,
    });
    await this.store.markBrowserExecutionSessionDeleted({
      executionId: claimed.executionId,
      workspaceId: claimed.workspaceId,
      claimToken,
      leaseEpoch: claimed.leaseEpoch,
    });
    await this.store.finishBrowserExecution({
      executionId: claimed.executionId,
      workspaceId: claimed.workspaceId,
      claimToken,
      leaseEpoch: claimed.leaseEpoch,
      errorCode,
    });
  }

  async closeAndMarkDeleted(
    claimed: NonNullable<
      Awaited<ReturnType<OpenInstinctStore["claimBrowserExecutionSlice"]>>
    >,
    sessionId: string,
    claimToken: string,
  ): Promise<void> {
    await this.browser.closeSession(sessionId);
    const health = await this.browser.sessionHealth(sessionId);
    if (health.healthy || !["closed", "missing"].includes(health.status))
      throw new Error("Provider browser session deletion was not verified.");
    await this.store.markBrowserExecutionSessionDeleted({
      executionId: claimed.executionId,
      workspaceId: claimed.workspaceId,
      claimToken,
      leaseEpoch: claimed.leaseEpoch,
    });
  }
}

function toProviderAction(
  action: BrowserReadAction,
  observation: BrowserReadObservation,
): BrowserInteraction {
  switch (action.type) {
    case "scroll":
    case "wait":
    case "switch_tab":
    case "close_tab":
      return action;
    case "go_back":
      return { type: "go_back" };
    case "dismiss_dialog":
      return { type: "dialog", response: "dismiss" };
  }
}
