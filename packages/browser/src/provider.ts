import { z } from "zod";

export const browserProfileStateSchema = z.enum([
  "provisioning",
  "needs_login",
  "active",
  "needs_reauth",
  "revoked",
  "error",
]);
export type BrowserProfileState = z.infer<typeof browserProfileStateSchema>;

export const browserCapabilitySchema = z.object({
  profiles: z.boolean(),
  reconnect: z.boolean(),
  checkpoint: z.boolean(),
  structuredObservation: z.boolean(),
  screenshots: z.boolean(),
  fileTransfer: z.boolean(),
  humanTakeover: z.boolean(),
  replayControl: z.boolean(),
  networkReadOnlyIsolation: z.boolean(),
  sessionLookupByCorrelation: z.boolean(),
  startIdempotency: z.boolean(),
  maxSessionSeconds: z.number().int().positive(),
});
export type BrowserCapabilities = z.infer<typeof browserCapabilitySchema>;

export interface BrowserProfile {
  readonly id: string;
  readonly name?: string;
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly lastUsedAt?: string;
}
export interface BrowserSession {
  readonly id: string;
  readonly profileId?: string;
  readonly status: "active" | "closed" | "error";
  readonly createdAt: string;
  readonly expiresAt: string;
}
export interface BrowserHealth {
  readonly healthy: boolean;
  readonly status: string;
  readonly checkedAt: string;
  readonly reason?: string;
}
export interface BrowserAuthenticationVerification {
  readonly verified: boolean;
  readonly method: string;
  readonly checkedAt: string;
  readonly reason?: string;
}
export interface BrowserObservation {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly links: readonly { text: string; href: string }[];
  readonly tabCount?: number;
}

export const browserInteractionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), url: z.string().url() }),
  z.object({ type: z.literal("click"), selector: z.string().min(1).max(500) }),
  z.object({
    type: z.literal("type_text"),
    selector: z.string().min(1).max(500),
    text: z.string().max(10_000),
  }),
  z.object({
    type: z.literal("select"),
    selector: z.string().min(1).max(500),
    value: z.string().max(1_000),
  }),
  z.object({
    type: z.literal("scroll"),
    deltaY: z.number().int().min(-5_000).max(5_000),
  }),
  z.object({ type: z.literal("press_key"), key: z.string().min(1).max(50) }),
  z.object({
    type: z.literal("wait"),
    milliseconds: z.number().int().min(0).max(5_000),
  }),
  z.object({ type: z.literal("go_back") }),
  z.object({ type: z.literal("open_tab"), url: z.string().url().optional() }),
  z.object({
    type: z.literal("close_tab"),
    index: z.number().int().min(0).max(20),
  }),
  z.object({
    type: z.literal("switch_tab"),
    index: z.number().int().min(0).max(20),
  }),
  z.object({
    type: z.literal("dialog"),
    response: z.enum(["accept", "dismiss"]),
  }),
]);
export type BrowserInteraction = z.infer<typeof browserInteractionSchema>;

export interface BrowserActionResult {
  readonly url?: string;
  readonly title?: string;
  readonly completed: boolean;
}
export interface BrowserCredentialInjection {
  readonly exactOrigin: string;
  readonly usernameSelector: string;
  readonly passwordSelector: string;
  readonly submitSelector?: string;
  readonly frameOrigin: string | null;
  readonly username: Uint8Array;
  readonly password: Uint8Array;
  readonly timeoutMs: number;
}
export interface BrowserTakeoverCapability {
  readonly url: string;
  readonly expiresAt: string;
}
export interface BrowserFile {
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface BrowserProvider {
  capabilities(): Promise<BrowserCapabilities>;
  createProfile(input: { name: string }): Promise<BrowserProfile>;
  listProfiles(input?: {
    exactName?: string;
  }): Promise<readonly BrowserProfile[]>;
  inspectProfile(profileId: string): Promise<BrowserProfile>;
  deleteProfile(profileId: string): Promise<{ verified: boolean }>;
  profileHealth(profileId: string): Promise<BrowserHealth>;
  startSession(input: {
    startUrl?: string;
    profileId?: string;
    timeoutSeconds?: number;
    purpose:
      | "automation"
      | "enrollment"
      | "reauthentication"
      | "health"
      | "takeover";
    correlationId?: string;
    readOnly?: boolean;
  }): Promise<BrowserSession>;
  findSessions(input: {
    correlationId: string;
    includeClosed?: boolean;
  }): Promise<readonly BrowserSession[]>;
  installReadOnlyGuards(
    sessionId: string,
    allowedOrigins: readonly string[],
  ): Promise<{ installed: boolean; fullyIsolated: boolean }>;
  reconnectSession(sessionId: string): Promise<BrowserSession>;
  sessionHealth(sessionId: string): Promise<BrowserHealth>;
  checkpointSession(
    sessionId: string,
  ): Promise<{ checkpointed: boolean; reason?: string }>;
  closeSession(sessionId: string): Promise<void>;
  observe(sessionId: string): Promise<BrowserObservation>;
  verifyAuthentication(
    sessionId: string,
    exactOrigin: string,
  ): Promise<BrowserAuthenticationVerification>;
  executeAction(
    sessionId: string,
    action: BrowserInteraction,
  ): Promise<BrowserActionResult>;
  injectCredentialFields(
    sessionId: string,
    input: BrowserCredentialInjection,
  ): Promise<{ completed: true; origin: string }>;
  screenshot(sessionId: string): Promise<Uint8Array>;
  captureRedactedScreenshot(sessionId: string): Promise<{
    bytes?: Uint8Array;
    omittedReason?: string;
    redactionVersion: string;
  }>;
  uploadFile(
    sessionId: string,
    file: BrowserFile,
  ): Promise<{ remotePath: string }>;
  downloadFile(
    sessionId: string,
    remotePath: string,
    maxBytes: number,
  ): Promise<BrowserFile>;
  takeover(sessionId: string): Promise<BrowserTakeoverCapability>;
  startReplay(sessionId: string): Promise<{ replayId: string }>;
  stopReplay(sessionId: string, replayId: string): Promise<void>;
}

export const browserStepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("goto"), url: z.string().url() }),
  z.object({
    action: z.literal("click"),
    selector: z.string().min(1).max(500),
  }),
  z.object({
    action: z.literal("fill"),
    selector: z.string().min(1).max(500),
    value: z.string().max(10_000),
  }),
  z.object({
    action: z.literal("select"),
    selector: z.string().min(1).max(500),
    value: z.string().max(1_000),
  }),
  z.object({
    action: z.literal("wait"),
    milliseconds: z.number().int().min(0).max(5_000),
  }),
]);
export const browserActionSchema = z.object({
  startUrl: z.string().url(),
  profileId: z.string().uuid().optional(),
  steps: z.array(browserStepSchema).min(1).max(20),
});
export type BrowserAction = z.infer<typeof browserActionSchema>;

export function legacyStepToInteraction(
  step: BrowserAction["steps"][number],
): BrowserInteraction {
  if (step.action === "goto") return { type: "navigate", url: step.url };
  if (step.action === "click")
    return { type: "click", selector: step.selector };
  if (step.action === "fill")
    return { type: "type_text", selector: step.selector, text: step.value };
  if (step.action === "select")
    return { type: "select", selector: step.selector, value: step.value };
  return { type: "wait", milliseconds: step.milliseconds };
}
