import { randomUUID } from "node:crypto";
import type {
  BrowserActionResult,
  BrowserAuthenticationVerification,
  BrowserCapabilities,
  BrowserCredentialInjection,
  BrowserFile,
  BrowserHealth,
  BrowserInteraction,
  BrowserObservation,
  BrowserProfile,
  BrowserProvider,
  BrowserSession,
  BrowserTakeoverCapability,
} from "./provider";

export class FakeBrowserProvider implements BrowserProvider {
  readonly #profiles = new Map<string, BrowserProfile>();
  readonly #sessions = new Map<string, BrowserSession>();
  readonly #sessionCorrelations = new Map<string, string>();
  readonly #correlationSessions = new Map<string, string>();
  readonly #files = new Map<string, BrowserFile>();
  async capabilities(): Promise<BrowserCapabilities> {
    return {
      profiles: true,
      reconnect: true,
      checkpoint: true,
      structuredObservation: true,
      screenshots: true,
      fileTransfer: true,
      humanTakeover: true,
      replayControl: true,
      networkReadOnlyIsolation: true,
      sessionLookupByCorrelation: true,
      startIdempotency: true,
      maxSessionSeconds: 3600,
    };
  }
  async createProfile(input: { name: string }): Promise<BrowserProfile> {
    const now = new Date().toISOString();
    const value = { id: randomUUID(), name: input.name, createdAt: now };
    this.#profiles.set(value.id, value);
    return value;
  }
  async listProfiles(input?: {
    exactName?: string;
  }): Promise<readonly BrowserProfile[]> {
    return [...this.#profiles.values()].filter(
      (profile) => !input?.exactName || profile.name === input.exactName,
    );
  }
  async inspectProfile(id: string): Promise<BrowserProfile> {
    const value = this.#profiles.get(id);
    if (!value) throw new Error("Profile not found.");
    return value;
  }
  async deleteProfile(id: string): Promise<{ verified: boolean }> {
    this.#profiles.delete(id);
    return { verified: !this.#profiles.has(id) };
  }
  async profileHealth(id: string): Promise<BrowserHealth> {
    return this.#health(
      this.#profiles.has(id),
      this.#profiles.has(id) ? "available" : "missing",
    );
  }
  async startSession(input: {
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
  }): Promise<BrowserSession> {
    if (input.profileId) await this.inspectProfile(input.profileId);
    const existingId = input.correlationId
      ? this.#correlationSessions.get(input.correlationId)
      : undefined;
    const existing = existingId ? this.#sessions.get(existingId) : undefined;
    if (existing?.status === "active") return existing;
    const now = new Date();
    const value = {
      id: randomUUID(),
      ...(input.profileId ? { profileId: input.profileId } : {}),
      status: "active" as const,
      createdAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + (input.timeoutSeconds ?? 900) * 1000,
      ).toISOString(),
    };
    this.#sessions.set(value.id, value);
    if (input.correlationId) {
      this.#sessionCorrelations.set(value.id, input.correlationId);
      this.#correlationSessions.set(input.correlationId, value.id);
    }
    return value;
  }
  async findSessions(input: {
    correlationId: string;
    includeClosed?: boolean;
  }): Promise<readonly BrowserSession[]> {
    return [...this.#sessions.values()].filter(
      (session) =>
        this.#sessionCorrelations.get(session.id) === input.correlationId &&
        (input.includeClosed || session.status === "active"),
    );
  }
  async installReadOnlyGuards(
    id: string,
    allowedOrigins: readonly string[],
  ): Promise<{ installed: boolean; fullyIsolated: boolean }> {
    this.#session(id);
    if (
      allowedOrigins.some((origin) => {
        const url = new URL(origin);
        return url.protocol !== "https:" || url.origin !== origin;
      })
    )
      throw new Error("Read-only browser origins must be exact HTTPS origins.");
    return { installed: true, fullyIsolated: true };
  }
  async reconnectSession(id: string): Promise<BrowserSession> {
    return this.#session(id);
  }
  async sessionHealth(id: string): Promise<BrowserHealth> {
    const session = this.#sessions.get(id);
    return this.#health(
      session?.status === "active",
      session?.status ?? "missing",
    );
  }
  async checkpointSession(id: string): Promise<{ checkpointed: boolean }> {
    this.#session(id);
    return { checkpointed: true };
  }
  async closeSession(id: string): Promise<void> {
    const value = this.#session(id);
    this.#sessions.set(id, { ...value, status: "closed" });
  }
  async observe(id: string): Promise<BrowserObservation> {
    this.#session(id);
    return {
      url: "https://example.test/",
      title: "Example",
      text: "Fake page",
      links: [],
      tabCount: 1,
    };
  }
  async verifyAuthentication(
    id: string,
    exactOrigin: string,
  ): Promise<BrowserAuthenticationVerification> {
    this.#session(id);
    return {
      verified: exactOrigin === "https://example.test",
      method: "deterministic_fake",
      checkedAt: new Date().toISOString(),
    };
  }
  async executeAction(
    id: string,
    _action: BrowserInteraction,
  ): Promise<BrowserActionResult> {
    this.#session(id);
    return { completed: true, url: "https://example.test/", title: "Example" };
  }
  async injectCredentialFields(
    id: string,
    input: BrowserCredentialInjection,
  ): Promise<{ completed: true; origin: string }> {
    this.#session(id);
    if (input.exactOrigin !== "https://example.test")
      throw new Error("Credential injection origin mismatch.");
    if (input.frameOrigin && input.frameOrigin !== input.exactOrigin)
      throw new Error("Cross-origin credential frames are not supported.");
    if (input.username.byteLength === 0 || input.password.byteLength === 0)
      throw new Error("Credential is empty.");
    return { completed: true, origin: input.exactOrigin };
  }
  async screenshot(id: string): Promise<Uint8Array> {
    this.#session(id);
    return new Uint8Array([1, 2, 3]);
  }
  async captureRedactedScreenshot(id: string): Promise<{
    bytes: Uint8Array;
    redactionVersion: string;
  }> {
    this.#session(id);
    return { bytes: new Uint8Array([1, 2, 3]), redactionVersion: "fake-v1" };
  }
  async uploadFile(
    id: string,
    file: BrowserFile,
  ): Promise<{ remotePath: string }> {
    this.#session(id);
    const path = `/tmp/openinstinct/${file.name}`;
    this.#files.set(`${id}:${path}`, file);
    return { remotePath: path };
  }
  async downloadFile(
    id: string,
    path: string,
    maxBytes: number,
  ): Promise<BrowserFile> {
    this.#session(id);
    const file = this.#files.get(`${id}:${path}`);
    if (!file || file.bytes.byteLength > maxBytes)
      throw new Error("File unavailable.");
    return file;
  }
  async takeover(id: string): Promise<BrowserTakeoverCapability> {
    const session = this.#session(id);
    return {
      url: `https://takeover.example.test/${id}`,
      expiresAt: session.expiresAt,
    };
  }
  async startReplay(id: string): Promise<{ replayId: string }> {
    this.#session(id);
    return { replayId: randomUUID() };
  }
  async stopReplay(id: string, _replayId: string): Promise<void> {
    this.#session(id);
  }
  #session(id: string): BrowserSession {
    const value = this.#sessions.get(id);
    if (!value) throw new Error("Session not found.");
    return value;
  }
  #health(healthy: boolean, status: string): BrowserHealth {
    return { healthy, status, checkedAt: new Date().toISOString() };
  }
}
