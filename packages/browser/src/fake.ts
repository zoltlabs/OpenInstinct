import { randomUUID } from "node:crypto";
import type {
  BrowserActionResult,
  BrowserAuthenticationVerification,
  BrowserCapabilities,
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
  }): Promise<BrowserSession> {
    if (input.profileId) await this.inspectProfile(input.profileId);
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
    return value;
  }
  async reconnectSession(id: string): Promise<BrowserSession> {
    return this.#session(id);
  }
  async sessionHealth(id: string): Promise<BrowserHealth> {
    return this.#health(
      this.#sessions.has(id),
      this.#sessions.has(id) ? "active" : "missing",
    );
  }
  async checkpointSession(id: string): Promise<{ checkpointed: boolean }> {
    this.#session(id);
    return { checkpointed: true };
  }
  async closeSession(id: string): Promise<void> {
    this.#sessions.delete(id);
  }
  async observe(id: string): Promise<BrowserObservation> {
    this.#session(id);
    return {
      url: "https://example.test/",
      title: "Example",
      text: "Fake page",
      links: [],
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
  async screenshot(id: string): Promise<Uint8Array> {
    this.#session(id);
    return new Uint8Array([1, 2, 3]);
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
