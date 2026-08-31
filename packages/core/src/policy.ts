import {
  authorityGrantSchema,
  semanticActionIntentSchema,
  type AuthorityGrant,
  type SemanticActionIntent,
} from "./semantic-authority";

export type PolicyDecision =
  | { type: "allow"; reason: string; authorityGrantId?: string }
  | { type: "approval"; reason: string; typedConfirmationRequired: boolean }
  | { type: "handoff"; reason: string }
  | { type: "deny"; reason: string };

export interface OwnerPolicy {
  readonly maxProactiveMessagesPerDay: number;
  readonly quietHoursEnd: number;
  readonly quietHoursStart: number;
  readonly timezone: string;
}

export interface AuthorityGrantUsage {
  readonly uses: number;
  readonly lastUsedAt?: string;
  readonly rollingMinorUnits?: string;
}

export const defaultOwnerPolicy: OwnerPolicy = {
  maxProactiveMessagesPerDay: 5,
  quietHoursEnd: 8,
  quietHoursStart: 22,
  timezone: "UTC",
};

function exceedsMoney(
  value: { currency: string; minorUnits: string },
  limit: { currency: string; minorUnits: string },
): boolean {
  return (
    value.currency !== limit.currency ||
    BigInt(value.minorUnits) > BigInt(limit.minorUnits)
  );
}

function isHourWithinWindow(hour: number, start: number, end: number): boolean {
  return start > end
    ? hour >= start || hour < end
    : hour >= start && hour < end;
}

function withinGrantQuietHours(date: Date, grant: AuthorityGrant): boolean {
  if (!grant.quietHours) return false;
  return isHourWithinWindow(
    Number(
      new Intl.DateTimeFormat("en-US", {
        hour: "2-digit",
        hour12: false,
        timeZone: grant.quietHours.timezone,
      }).format(date),
    ),
    grant.quietHours.startHour,
    grant.quietHours.endHour,
  );
}

function grantMatches(input: {
  intent: SemanticActionIntent;
  grant: AuthorityGrant;
  usage: AuthorityGrantUsage;
  now: Date;
}): boolean {
  const { intent, grant, usage, now } = input;
  if (
    grant.revokedAt ||
    now < new Date(grant.startsAt) ||
    now >= new Date(grant.expiresAt) ||
    grant.alwaysRequireFreshApproval ||
    grant.alwaysRequireHumanTakeover ||
    !grant.effects.includes(intent.effect) ||
    !grant.resourceClasses.includes(intent.resource.class) ||
    !grant.providers.includes(intent.provider) ||
    (grant.origins.length > 0 &&
      (!intent.exactOrigin || !grant.origins.includes(intent.exactOrigin))) ||
    (grant.accountIds.length > 0 &&
      (!intent.account || !grant.accountIds.includes(intent.account.id))) ||
    (grant.counterpartyIds.length > 0 &&
      (!intent.counterparty ||
        !grant.counterpartyIds.includes(intent.counterparty.id))) ||
    (intent.recipients.length > 0 &&
      (grant.recipientIds.length === 0 ||
        intent.recipients.some(
          (recipient) => !grant.recipientIds.includes(recipient.id),
        ))) ||
    withinGrantQuietHours(now, grant) ||
    (grant.maxUses !== null && usage.uses >= grant.maxUses)
  )
    return false;
  if (
    grant.minimumIntervalSeconds > 0 &&
    usage.lastUsedAt &&
    now.getTime() - Date.parse(usage.lastUsedAt) <
      grant.minimumIntervalSeconds * 1_000
  )
    return false;
  if (intent.amount && grant.perActionLimit) {
    if (exceedsMoney(intent.amount, grant.perActionLimit)) return false;
  } else if (intent.amount || grant.perActionLimit) return false;
  if (grant.rollingLimit) {
    if (
      !intent.amount ||
      intent.amount.currency !== grant.rollingLimit.amount.currency
    )
      return false;
    if (
      BigInt(usage.rollingMinorUnits ?? "0") +
        BigInt(intent.amount.minorUnits) >
      BigInt(grant.rollingLimit.amount.minorUnits)
    )
      return false;
  }
  return true;
}

export function decideSemanticAction(input: {
  intent: SemanticActionIntent;
  grants?: readonly {
    grant: AuthorityGrant;
    usage: AuthorityGrantUsage;
  }[];
  now?: Date;
}): PolicyDecision {
  const intent = semanticActionIntentSchema.parse(input.intent);
  const now = input.now ?? new Date();
  if (intent.effect === "security_change")
    return {
      type: "deny",
      reason: "Security, password, MFA, and recovery changes are disabled.",
    };
  if (intent.credentialUse === "payment" && intent.effect !== "purchase")
    return {
      type: "deny",
      reason: "Payment credentials are valid only inside the financial pilot.",
    };
  if (["password", "otp"].includes(intent.credentialUse))
    return {
      type: "handoff",
      reason: "Password and OTP use requires owner takeover.",
    };
  if (!intent.commitPoint)
    return { type: "allow", reason: "The action has no consequential commit." };
  if (intent.effect === "purchase")
    return {
      type: "approval",
      typedConfirmationRequired: true,
      reason:
        "Sandbox purchases require a fresh approval of merchant, total, recurring terms, and payment alias.",
    };
  if (["delete", "cancel"].includes(intent.effect))
    return {
      type: "approval",
      typedConfirmationRequired: true,
      reason: "Destructive actions require a fresh exact typed confirmation.",
    };
  for (const candidate of input.grants ?? []) {
    const grant = authorityGrantSchema.parse(candidate.grant);
    if (grantMatches({ intent, grant, usage: candidate.usage, now }))
      return {
        type: "allow",
        authorityGrantId: grant.id,
        reason: `Allowed by authority grant ${grant.name}.`,
      };
  }
  if (intent.effect === "send")
    return {
      type: "approval",
      typedConfirmationRequired: false,
      reason:
        "Communication requires approval of exact recipients and content.",
    };
  return {
    type: "approval",
    typedConfirmationRequired: false,
    reason: "This exact semantic commit requires owner approval.",
  };
}

export function isQuietHour(date: Date, policy: OwnerPolicy): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      hour12: false,
      timeZone: policy.timezone,
    }).format(date),
  );
  return isHourWithinWindow(hour, policy.quietHoursStart, policy.quietHoursEnd);
}
