import type { ActionRisk } from "./domain";

export type PolicyDecision =
  | { type: "allow"; reason: string }
  | { type: "approval"; reason: string }
  | { type: "deny"; reason: string };

export interface OwnerPolicy {
  readonly autoWriteCalendar: boolean;
  readonly maxProactiveMessagesPerDay: number;
  readonly quietHoursEnd: number;
  readonly quietHoursStart: number;
  readonly timezone: string;
}

export const defaultOwnerPolicy: OwnerPolicy = {
  autoWriteCalendar: false,
  maxProactiveMessagesPerDay: 5,
  quietHoursEnd: 8,
  quietHoursStart: 22,
  timezone: "UTC",
};

export function decideAction(input: {
  risk: ActionRisk;
  toolName: string;
  policy?: OwnerPolicy;
}): PolicyDecision {
  const policy = input.policy ?? defaultOwnerPolicy;
  if (input.risk === "read") {
    return { type: "allow", reason: "Read-only tools are allowed." };
  }
  if (input.toolName === "google.calendar.create" && policy.autoWriteCalendar) {
    return {
      type: "allow",
      reason: "The owner explicitly enabled automatic calendar writes.",
    };
  }
  if (["security", "financial"].includes(input.risk)) {
    return {
      type: "deny",
      reason: `${input.risk} actions are disabled in the initial release.`,
    };
  }
  if (input.risk === "destructive") {
    return {
      type: "approval",
      reason:
        "Destructive actions require explicit owner confirmation of the exact payload.",
    };
  }
  return {
    type: "approval",
    reason: "Consequential external writes require owner approval.",
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
  return policy.quietHoursStart > policy.quietHoursEnd
    ? hour >= policy.quietHoursStart || hour < policy.quietHoursEnd
    : hour >= policy.quietHoursStart && hour < policy.quietHoursEnd;
}
