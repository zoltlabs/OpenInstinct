import { z } from "zod";
import { payloadHash } from "./domain";

export const browserReadActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("scroll"),
    deltaY: z.number().int().min(-2_000).max(2_000),
  }),
  z.object({
    type: z.literal("wait"),
    milliseconds: z.number().int().min(100).max(2_000),
  }),
  z.object({
    type: z.literal("switch_tab"),
    index: z.number().int().min(0).max(4),
  }),
  z.object({
    type: z.literal("close_tab"),
    index: z.number().int().min(0).max(4),
  }),
  z.object({ type: z.literal("go_back") }),
  z.object({ type: z.literal("dismiss_dialog") }),
]);
export type BrowserReadAction = z.infer<typeof browserReadActionSchema>;

export const browserReadDecisionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("act"),
    action: browserReadActionSchema,
    rationale: z.string().min(1).max(500),
  }),
  z.object({
    type: z.literal("finish"),
    summary: z.string().min(1).max(4_000),
  }),
  z.object({
    type: z.literal("request_owner_takeover"),
    reason: z.string().min(1).max(500),
  }),
]);
export type BrowserReadDecision = z.infer<typeof browserReadDecisionSchema>;

export const browserReadObservationSchema = z.object({
  id: z.string().uuid(),
  hash: z.string().regex(/^[0-9a-f]{64}$/u),
  origin: z.string().url().max(500),
  path: z.string().max(1_000),
  title: z.string().max(500),
  text: z.string().max(12_000),
  links: z
    .array(
      z.object({
        text: z.string().max(300),
        href: z.string().url().max(1_500),
        hrefHash: z.string().regex(/^[0-9a-f]{64}$/u),
      }),
    )
    .max(12),
  tabCount: z.number().int().min(1).max(5),
  suspicious: z.boolean(),
  redactionVersion: z.string().min(1).max(100),
  screenshotHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .optional(),
  screenshotOmittedReason: z.string().min(1).max(128).optional(),
});
export type BrowserReadObservation = z.infer<
  typeof browserReadObservationSchema
>;

const forbiddenHost = /^(localhost|metadata\.google\.internal)$/iu;
const sensitiveQuery =
  /token|secret|password|passcode|otp|code|key|auth|session|signature|credential/iu;

export function canonicalBrowserReadUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Browser reads require credential-free HTTPS URLs.");
  if (
    forbiddenHost.test(url.hostname) ||
    url.hostname.endsWith(".local") ||
    /^127\.|^10\.|^192\.168\.|^169\.254\.|^0\.|^\[?::1\]?$/u.test(url.hostname)
  )
    throw new Error("Browser reads cannot target local or metadata hosts.");
  if (
    [...url.searchParams.keys()].some((key) => sensitiveQuery.test(key)) ||
    url.search.length > 1_000
  )
    throw new Error(
      "Browser read URL contains sensitive or oversized query data.",
    );
  url.hash = "";
  return url;
}

export function validateBrowserReadTarget(input: {
  url: string;
  allowedOrigins: readonly string[];
}): URL {
  const url = canonicalBrowserReadUrl(input.url);
  if (!input.allowedOrigins.includes(url.origin))
    throw new Error("Browser read target is outside the exact origin policy.");
  return url;
}

export function validateBrowserReadAction(input: {
  action: BrowserReadAction;
  observation: BrowserReadObservation;
  allowedOrigins: readonly string[];
  remainingSteps: number;
}): BrowserReadAction {
  const action = browserReadActionSchema.parse(input.action);
  const observation = browserReadObservationSchema.parse(input.observation);
  if (input.remainingSteps <= 0)
    throw new Error("Browser read step budget is exhausted.");
  if (observation.suspicious && !["close_tab", "go_back"].includes(action.type))
    throw new Error("Suspicious page content requires owner review or exit.");
  if (
    (action.type === "switch_tab" || action.type === "close_tab") &&
    action.index >= observation.tabCount
  )
    throw new Error("Browser tab is outside the observed tab set.");
  return action;
}

export function browserReadObservationHash(input: {
  origin: string;
  path: string;
  title: string;
  text: string;
  links: readonly { text: string; href: string }[];
  tabCount: number;
  suspicious: boolean;
  redactionVersion: string;
  screenshotHash?: string;
  screenshotOmittedReason?: string;
}): string {
  return payloadHash(input);
}
