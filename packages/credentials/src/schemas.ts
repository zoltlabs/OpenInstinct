import { z } from "zod";
import { createHash } from "node:crypto";

export function canonicalCredentialOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value)
    throw new Error("Credential origins must be exact HTTPS origins.");
  return url.origin;
}

export const credentialKindSchema = z.enum(["website_password"]);
export const credentialStatusSchema = z.enum([
  "active",
  "needs_verification",
  "revoked",
  "deletion_pending",
  "deleted",
]);
export const exactCredentialOriginSchema = z
  .string()
  .url()
  .transform(canonicalCredentialOrigin);

export const credentialItemSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  kind: credentialKindSchema,
  label: z.string().trim().min(1).max(200),
  usernameHint: z.string().trim().max(200).nullable(),
  allowedOrigins: z.array(exactCredentialOriginSchema).min(1).max(20),
  status: credentialStatusSchema,
  recordVersion: z.number().int().positive(),
  configurationVersion: z.string().regex(/^[0-9a-f]{64}$/u),
  encryptionKeyVersion: z.number().int().positive(),
  lastVerifiedAt: z.string().datetime().nullable(),
  rotationDueAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
});
export type CredentialItem = z.infer<typeof credentialItemSchema>;

export const credentialSecretSchema = z.object({
  username: z.string().min(1).max(1_000),
  password: z.string().min(1).max(20_000),
});
export type CredentialSecret = z.infer<typeof credentialSecretSchema>;

export const credentialEnvelopeSchema = z.object({
  version: z.literal(1),
  keyVersion: z.number().int().positive(),
  wrappedKeyNonce: z.string().min(16).max(64),
  wrappedKeyTag: z.string().min(16).max(64),
  wrappedKeyCiphertext: z.string().min(32).max(128),
  payloadNonce: z.string().min(16).max(64),
  payloadTag: z.string().min(16).max(64),
  payloadCiphertext: z.string().min(1).max(100_000),
});
export type CredentialEnvelope = z.infer<typeof credentialEnvelopeSchema>;

export const credentialFieldBindingSchema = z.object({
  usernameSelector: z.string().min(1).max(500),
  passwordSelector: z.string().min(1).max(500),
  submitSelector: z.string().min(1).max(500).optional(),
  frameOrigin: exactCredentialOriginSchema.nullable().default(null),
});
export type CredentialFieldBinding = z.infer<
  typeof credentialFieldBindingSchema
>;

export const credentialUseContextSchema = z.object({
  workspaceId: z.string().uuid(),
  credentialItemId: z.string().uuid(),
  credentialConfigurationVersion: z.string().regex(/^[0-9a-f]{64}$/u),
  exactOrigin: exactCredentialOriginSchema,
  browserProfileId: z.string().uuid(),
  browserProfileConfigurationVersion: z.number().int().positive(),
  browserExecutionId: z.string().uuid().nullable(),
  browserControlSessionId: z.string().uuid(),
  runId: z.string().uuid().nullable(),
  actionRequestId: z.string().uuid().nullable(),
  reason: z.string().trim().min(1).max(500),
  fields: credentialFieldBindingSchema,
});
export type CredentialUseContext = z.infer<typeof credentialUseContextSchema>;

export function credentialConfigurationVersion(input: {
  kind: "website_password";
  allowedOrigins: readonly string[];
  recordVersion: number;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: input.kind,
        allowedOrigins: [...input.allowedOrigins]
          .map(canonicalCredentialOrigin)
          .sort(),
        recordVersion: input.recordVersion,
      }),
    )
    .digest("hex");
}
