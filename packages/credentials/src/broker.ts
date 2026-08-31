import {
  canonicalCredentialOrigin,
  credentialItemSchema,
  credentialUseContextSchema,
  type CredentialItem,
  type CredentialUseContext,
} from "./schemas";

export function validateCredentialUse(input: {
  item: CredentialItem;
  context: CredentialUseContext;
  allowNeedsVerification?: boolean;
}): { item: CredentialItem; context: CredentialUseContext } {
  const item = credentialItemSchema.parse(input.item);
  const context = credentialUseContextSchema.parse(input.context);
  if (item.workspaceId !== context.workspaceId)
    throw new Error("Credential workspace does not match the execution.");
  if (item.id !== context.credentialItemId)
    throw new Error("Credential reference does not match the execution.");
  if (
    item.status !== "active" &&
    !(input.allowNeedsVerification && item.status === "needs_verification")
  )
    throw new Error("Credential is not active.");
  if (item.configurationVersion !== context.credentialConfigurationVersion)
    throw new Error("Credential configuration changed before use.");
  const origin = canonicalCredentialOrigin(context.exactOrigin);
  if (!item.allowedOrigins.includes(origin))
    throw new Error("Credential is not authorized for this exact origin.");
  if (context.fields.frameOrigin && context.fields.frameOrigin !== origin)
    throw new Error("Cross-origin credential frames are not supported.");
  return { item, context };
}
