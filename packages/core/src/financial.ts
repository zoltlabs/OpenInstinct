import { z } from "zod";
import { normalizeJsonValue, payloadHash } from "./canonical-json";
import { moneySchema } from "./semantic-authority";

const stableLabel = z.string().trim().min(1).max(256);

export const financialRecurringTermsSchema = z.object({
  interval: z.enum(["week", "month", "year"]),
  intervalCount: z.number().int().min(1).max(24).default(1),
  occurrences: z.number().int().min(1).max(120).nullable(),
  trialEndsAt: z.string().datetime().nullable(),
  cancelBy: z.string().datetime().nullable(),
});

export const financialPurchaseSelectionSchema = z.object({
  merchantId: stableLabel,
  itemId: stableLabel,
  itemDescription: stableLabel,
  quantity: z.number().int().min(1).max(100),
  unitAmount: moneySchema,
  recurringTerms: financialRecurringTermsSchema.nullable().default(null),
  paymentAliasId: z.string().uuid(),
});

export const financialPreflightSchema = financialPurchaseSelectionSchema.extend(
  {
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    provider: z.literal("openinstinct_sandbox"),
    totalAmount: moneySchema,
    quoteExpiresAt: z.string().datetime(),
    merchantConfigurationVersion: z.string().regex(/^[a-f0-9]{64}$/u),
    paymentAliasConfigurationVersion: z.string().regex(/^[a-f0-9]{64}$/u),
    settingsConfigurationVersion: z.string().regex(/^[a-f0-9]{64}$/u),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    preflightHash: z.string().regex(/^[a-f0-9]{64}$/u),
  },
);

export const financialPurchaseActionInputSchema = z.object({
  preflight: financialPreflightSchema,
});

export const financialAdjustmentActionInputSchema = z.object({
  transactionId: z.string().uuid(),
  operation: z.enum(["refund", "cancellation"]),
  amount: moneySchema,
  reason: z.string().trim().min(1).max(1_000),
});

export type FinancialRecurringTerms = z.infer<
  typeof financialRecurringTermsSchema
>;
export type FinancialPurchaseSelection = z.infer<
  typeof financialPurchaseSelectionSchema
>;
export type FinancialPreflight = z.infer<typeof financialPreflightSchema>;
export type FinancialPurchaseActionInput = z.infer<
  typeof financialPurchaseActionInputSchema
>;
export type FinancialAdjustmentActionInput = z.infer<
  typeof financialAdjustmentActionInputSchema
>;

export function financialTotalAmount(input: {
  unitAmount: { currency: string; minorUnits: string };
  quantity: number;
}) {
  return moneySchema.parse({
    currency: input.unitAmount.currency,
    minorUnits: (
      BigInt(input.unitAmount.minorUnits) * BigInt(input.quantity)
    ).toString(),
  });
}

export function financialConfigurationVersion(value: unknown): string {
  return payloadHash(normalizeJsonValue(value));
}

export function financialPreflightHash(
  value: Omit<FinancialPreflight, "preflightHash">,
): string {
  return payloadHash(normalizeJsonValue(value));
}

export function financialConfirmationPhrase(input: {
  totalAmount: { currency: string; minorUnits: string };
  merchantId: string;
  paymentAliasId: string;
}): string {
  return `CONFIRM PURCHASE ${input.totalAmount.minorUnits} ${input.totalAmount.currency} AT ${input.merchantId} WITH ${input.paymentAliasId}`;
}

export function financialAdjustmentConfirmationPhrase(
  input: FinancialAdjustmentActionInput,
): string {
  return `CONFIRM ${input.operation.toUpperCase()} ${input.amount.minorUnits} ${input.amount.currency} FOR ${input.transactionId}`;
}
