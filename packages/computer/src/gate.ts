import { z } from "zod";
import { VM_RUNTIME_ENABLED } from "./provider";

export const TRUSTED_VM_EVIDENCE_RESOLVER_ENABLED = false as const;

export const evidenceLevelSchema = z.enum([
  "not_tested",
  "documented",
  "demonstrated",
  "failed",
]);

export const evidenceClaimSchema = z
  .object({
    level: evidenceLevelSchema,
    source: z.enum([
      "none",
      "provider_documentation",
      "synthetic",
      "live_provider",
    ]),
    evidenceId: z.string().uuid().optional(),
    reviewId: z.string().uuid().optional(),
    recordedAt: z.string().datetime().optional(),
  })
  .superRefine((claim, context) => {
    if (
      claim.level === "demonstrated" &&
      (claim.source !== "live_provider" ||
        !claim.evidenceId ||
        !claim.reviewId ||
        !claim.recordedAt)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "demonstrated evidence requires reviewed live-provider provenance",
      });
    }
  });
export type EvidenceClaim = z.infer<typeof evidenceClaimSchema>;

export const vmWorkflowResultSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  highValueRecurring: z.boolean(),
  vmRequired: z.boolean(),
  browserAcceptance: z.enum(["passed", "failed", "not_tested"]),
  apiAcceptance: z.enum(["passed", "failed", "not_tested"]),
  evidence: evidenceClaimSchema,
  note: z.string().min(1).max(2_000),
});
export type VmWorkflowResult = z.infer<typeof vmWorkflowResultSchema>;

const controlsSchema = z.object({
  pauseResume: evidenceClaimSchema,
  filesystemPersistence: evidenceClaimSchema,
  snapshots: evidenceClaimSchema,
  deletion: evidenceClaimSchema,
  guiAndProcessControl: evidenceClaimSchema,
  networkPolicy: evidenceClaimSchema,
  takeover: evidenceClaimSchema,
  artifactHandling: evidenceClaimSchema,
  credentialIsolation: evidenceClaimSchema,
  decommissioning: evidenceClaimSchema,
});

export const vmProviderEvaluationSchema = z.object({
  provider: z.string().min(1).max(100),
  category: z.enum([
    "managed_persistent_vm",
    "sandbox_snapshot",
    "self_hosted_microvm",
  ]),
  controls: controlsSchema,
  failureInjection: evidenceClaimSchema,
  projectedMonthlyCostUsd: z.number().nonnegative().finite(),
  costVisibleToOwner: z.boolean(),
  costEvidence: evidenceClaimSchema,
  note: z.string().min(1).max(2_000),
});
export type VmProviderEvaluation = z.infer<typeof vmProviderEvaluationSchema>;

export const vmBuildGateInputSchema = z
  .object({
    workflows: z.array(vmWorkflowResultSchema).min(3),
    providers: z.array(vmProviderEvaluationSchema).min(3),
    ownerMonthlyCostLimitUsd: z.number().positive().finite(),
    securityReview: z.object({
      decision: z.enum(["approved", "rejected"]),
      evidence: evidenceClaimSchema,
    }),
  })
  .superRefine((input, context) => {
    const workflowIds = input.workflows.map((workflow) => workflow.id);
    const providers = input.providers.map((provider) => provider.provider);
    if (new Set(workflowIds).size !== workflowIds.length) {
      context.addIssue({
        code: "custom",
        message: "workflow ids must be unique",
      });
    }
    if (new Set(providers).size !== providers.length) {
      context.addIssue({ code: "custom", message: "providers must be unique" });
    }
  });
export type VmBuildGateInput = z.infer<typeof vmBuildGateInputSchema>;

export interface VmBuildGateResult {
  readonly build: boolean;
  readonly eligibleProviders: readonly string[];
  readonly checks: {
    readonly workflowDemand: boolean;
    readonly alternativesFailed: boolean;
    readonly providerCategoriesCovered: boolean;
    readonly providerReady: boolean;
    readonly failureInjectionPassed: boolean;
    readonly securityReviewApproved: boolean;
    readonly trustedEvidenceResolved: boolean;
    readonly runtimeReleaseEnabled: boolean;
  };
  readonly reasons: readonly string[];
}

function demonstrated(claim: EvidenceClaim): boolean {
  return claim.level === "demonstrated" && claim.source === "live_provider";
}

export function evaluateVmBuildGate(raw: VmBuildGateInput): VmBuildGateResult {
  const input = vmBuildGateInputSchema.parse(raw);
  const qualifying = input.workflows.filter(
    (workflow) => workflow.highValueRecurring && workflow.vmRequired,
  );
  const workflowDemand = qualifying.length >= 2;
  const alternativesFailed =
    qualifying.length >= 2 &&
    qualifying.every(
      (workflow) =>
        workflow.browserAcceptance === "failed" &&
        workflow.apiAcceptance === "failed" &&
        demonstrated(workflow.evidence),
    );
  const categories = new Set(
    input.providers.map((provider) => provider.category),
  );
  const providerCategoriesCovered =
    categories.has("managed_persistent_vm") &&
    categories.has("sandbox_snapshot") &&
    categories.has("self_hosted_microvm");
  const eligibleProviders = input.providers
    .filter(
      (provider) =>
        Object.values(provider.controls).every(demonstrated) &&
        demonstrated(provider.failureInjection) &&
        provider.costVisibleToOwner &&
        provider.projectedMonthlyCostUsd <= input.ownerMonthlyCostLimitUsd &&
        demonstrated(provider.costEvidence),
    )
    .map((provider) => provider.provider);
  const providerReady = eligibleProviders.length > 0;
  const failureInjectionPassed = input.providers.some(
    (provider) =>
      eligibleProviders.includes(provider.provider) &&
      demonstrated(provider.failureInjection),
  );
  const securityReviewApproved =
    input.securityReview.decision === "approved" &&
    demonstrated(input.securityReview.evidence);
  // The no-build phase has no durable evidence repository. Shape-valid claims
  // remain untrusted until a future reviewed repository resolves and binds them.
  const trustedEvidenceResolved: boolean = TRUSTED_VM_EVIDENCE_RESOLVER_ENABLED;
  const runtimeReleaseEnabled: boolean = VM_RUNTIME_ENABLED;

  const checks = {
    workflowDemand,
    alternativesFailed,
    providerCategoriesCovered,
    providerReady,
    failureInjectionPassed,
    securityReviewApproved,
    trustedEvidenceResolved,
    runtimeReleaseEnabled,
  };
  const reasons: string[] = [];
  if (!workflowDemand)
    reasons.push("fewer than two high-value recurring workflows require a VM");
  if (!alternativesFailed)
    reasons.push(
      "browser and API alternatives have not both failed live tests",
    );
  if (!providerCategoriesCovered)
    reasons.push("all required provider categories were not evaluated");
  if (!providerReady)
    reasons.push(
      "no single provider has proven controls and acceptable visible cost",
    );
  if (!failureInjectionPassed)
    reasons.push("unknown-outcome failure injection has not passed");
  if (!securityReviewApproved)
    reasons.push("an evidence-backed security review has not approved release");
  if (!trustedEvidenceResolved)
    reasons.push("durable VM evidence resolution is not implemented");
  if (!runtimeReleaseEnabled)
    reasons.push("the VM runtime release gate is hard-disabled");

  return {
    build: Object.values(checks).every(Boolean),
    eligibleProviders,
    checks,
    reasons,
  };
}
