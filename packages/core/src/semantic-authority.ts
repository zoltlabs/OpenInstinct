import { z } from "zod";
import { normalizeJsonValue, payloadHash } from "./canonical-json";

const boundedLabelSchema = z.string().trim().min(1).max(512);
const stableIdentifierSchema = z.string().trim().min(1).max(512);

export const semanticEffectSchema = z.enum([
  "read",
  "create",
  "update",
  "send",
  "cancel",
  "delete",
  "purchase",
  "security_change",
]);

export const semanticPartySchema = z.object({
  id: stableIdentifierSchema,
  displayName: boundedLabelSchema.optional(),
});

export const semanticResourceSchema = z.object({
  class: z.string().trim().min(1).max(128),
  id: stableIdentifierSchema.optional(),
  displayName: boundedLabelSchema.optional(),
});

export const moneySchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/u),
  minorUnits: z.string().regex(/^(0|[1-9][0-9]{0,17})$/u),
});

export const semanticPostconditionSchema = z
  .object({
    subject: z.string().trim().min(1).max(256),
    operator: z.enum(["equals", "contains", "exists", "absent"]),
    expected: z.union([z.string().max(4_000), z.boolean()]).optional(),
  })
  .superRefine((item, context) => {
    const needsExpected = ["equals", "contains"].includes(item.operator);
    if (needsExpected !== (item.expected !== undefined))
      context.addIssue({
        code: "custom",
        path: ["expected"],
        message: `${item.operator} postconditions ${
          needsExpected ? "require" : "must not include"
        } an expected value.`,
      });
  });

export const semanticActionIntentSchema = z
  .object({
    version: z.literal(1),
    effect: semanticEffectSchema,
    resource: semanticResourceSchema,
    provider: z.string().trim().min(1).max(128),
    exactOrigin: z.string().url().max(2_048).nullable(),
    account: semanticPartySchema.optional(),
    counterparty: semanticPartySchema.optional(),
    recipients: z.array(semanticPartySchema).max(50).default([]),
    amount: moneySchema.optional(),
    reversibility: z.enum([
      "reversible",
      "conditionally_reversible",
      "irreversible",
    ]),
    commitPoint: z.boolean(),
    credentialUse: z.enum(["none", "session", "password", "otp", "payment"]),
    postconditions: z.array(semanticPostconditionSchema).max(20).default([]),
  })
  .superRefine((intent, context) => {
    if (
      intent.exactOrigin &&
      (new URL(intent.exactOrigin).origin !== intent.exactOrigin ||
        new URL(intent.exactOrigin).protocol !== "https:")
    )
      context.addIssue({
        code: "custom",
        path: ["exactOrigin"],
        message: "Origin must contain only scheme, host, and optional port.",
      });
    if (intent.effect === "send" && intent.recipients.length === 0)
      context.addIssue({
        code: "custom",
        path: ["recipients"],
        message: "Send intents require at least one exact recipient.",
      });
    if (intent.effect === "purchase" && !intent.amount)
      context.addIssue({
        code: "custom",
        path: ["amount"],
        message: "Purchase intents require an exact maximum amount.",
      });
  });

export const semanticGuardConditionsSchema = z.object({
  version: z.literal(1),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/u),
  exactOrigin: z.string().url().max(2_048).nullable(),
  accountId: stableIdentifierSchema.nullable(),
  counterpartyId: stableIdentifierSchema.nullable(),
  recipientIds: z.array(stableIdentifierSchema).max(50),
  amount: moneySchema.nullable(),
  connectionId: z.string().uuid().nullable(),
  connectionConfigVersion: stableIdentifierSchema.nullable(),
  browserProfileId: z.string().uuid().nullable(),
  browserProfileConfigVersion: stableIdentifierSchema.nullable(),
  observationHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
});

export const authorityGrantSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    version: z.number().int().positive(),
    name: z.string().trim().min(1).max(200),
    effects: z.array(semanticEffectSchema).min(1).max(8),
    resourceClasses: z.array(z.string().trim().min(1).max(128)).min(1).max(50),
    providers: z.array(z.string().trim().min(1).max(128)).min(1).max(50),
    origins: z.array(z.string().url().max(2_048)).max(50),
    accountIds: z.array(stableIdentifierSchema).max(50),
    counterpartyIds: z.array(stableIdentifierSchema).max(100),
    recipientIds: z.array(stableIdentifierSchema).max(100),
    perActionLimit: moneySchema.nullable(),
    rollingLimit: z
      .object({
        amount: moneySchema,
        windowSeconds: z.number().int().min(60).max(31_557_600),
      })
      .nullable(),
    maxUses: z.number().int().positive().nullable(),
    minimumIntervalSeconds: z.number().int().min(0).max(31_557_600),
    quietHours: z
      .object({
        startHour: z.number().int().min(0).max(23),
        endHour: z.number().int().min(0).max(23),
        timezone: z.string().trim().min(1).max(100),
      })
      .nullable(),
    startsAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    revokedAt: z.string().datetime().nullable(),
    alwaysRequireFreshApproval: z.boolean(),
    alwaysRequireHumanTakeover: z.boolean(),
    configurationVersion: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .superRefine((grant, context) => {
    for (const [index, origin] of grant.origins.entries())
      if (
        new URL(origin).origin !== origin ||
        new URL(origin).protocol !== "https:"
      )
        context.addIssue({
          code: "custom",
          path: ["origins", index],
          message: "Grant origins must be exact origins.",
        });
    if (Date.parse(grant.expiresAt) <= Date.parse(grant.startsAt))
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Grant expiry must be after its start.",
      });
  });

export const actionEvidenceSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  runId: z.string().uuid(),
  actionRequestId: z.string().uuid(),
  workflowStepId: z.string().uuid(),
  toolResultId: z.string().uuid().optional(),
  phase: z.enum([
    "before_commit",
    "commit_response",
    "postcondition",
    "reconciliation",
  ]),
  outcome: z.enum(["observed", "not_observed", "inconclusive"]),
  verifier: z.string().trim().min(1).max(128),
  verifierVersion: z.number().int().positive(),
  safeSummary: z.string().max(1_000).optional(),
  facts: z
    .record(z.string(), z.unknown())
    .refine(
      (value) => JSON.stringify(value).length <= 64_000,
      "Evidence facts must not exceed 64 KB.",
    ),
  capturedAt: z.string().datetime(),
});

export type SemanticEffect = z.infer<typeof semanticEffectSchema>;
export type SemanticParty = z.infer<typeof semanticPartySchema>;
export type SemanticResource = z.infer<typeof semanticResourceSchema>;
export type Money = z.infer<typeof moneySchema>;
export type SemanticPostcondition = z.infer<typeof semanticPostconditionSchema>;
export type SemanticActionIntent = z.infer<typeof semanticActionIntentSchema>;
export type SemanticGuardConditions = z.infer<
  typeof semanticGuardConditionsSchema
>;
export type AuthorityGrant = z.infer<typeof authorityGrantSchema>;
export type ActionEvidence = z.infer<typeof actionEvidenceSchema>;

export function canonicalOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Origin must use HTTPS.");
  return url.origin;
}

export function semanticIntentHash(intent: SemanticActionIntent): string {
  return payloadHash(semanticActionIntentSchema.parse(intent));
}

export function semanticGuardHash(guards: SemanticGuardConditions): string {
  return payloadHash(semanticGuardConditionsSchema.parse(guards));
}

export function authorityGrantConfigurationVersion(
  grant: Omit<AuthorityGrant, "configurationVersion">,
): string {
  return payloadHash(normalizeJsonValue(grant));
}

export function deriveSemanticGuards(input: {
  intent: SemanticActionIntent;
  payload: unknown;
  connectionId?: string | null;
  connectionConfigVersion?: string | null;
  browserProfileId?: string | null;
  browserProfileConfigVersion?: string | null;
  observationHash?: string | null;
}): SemanticGuardConditions {
  const intent = semanticActionIntentSchema.parse(input.intent);
  return semanticGuardConditionsSchema.parse({
    version: 1,
    payloadHash: payloadHash(input.payload),
    exactOrigin: intent.exactOrigin,
    accountId: intent.account?.id ?? null,
    counterpartyId: intent.counterparty?.id ?? null,
    recipientIds: intent.recipients.map((recipient) => recipient.id),
    amount: intent.amount ?? null,
    connectionId: input.connectionId ?? null,
    connectionConfigVersion: input.connectionConfigVersion ?? null,
    browserProfileId: input.browserProfileId ?? null,
    browserProfileConfigVersion: input.browserProfileConfigVersion ?? null,
    observationHash: input.observationHash ?? null,
  });
}
