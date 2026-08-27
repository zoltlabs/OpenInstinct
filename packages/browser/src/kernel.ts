import Kernel from "@onkernel/sdk";
import type { BrowserProvider, BrowserSession } from "./provider";

export class KernelBrowserProvider implements BrowserProvider {
  readonly #client: Kernel;

  constructor(apiKey: string) {
    this.#client = new Kernel({ apiKey });
  }

  async create(input: {
    startUrl?: string;
    profileId?: string;
    timeoutSeconds?: number;
  }): Promise<BrowserSession> {
    const browser = await this.#client.browsers.create({
      start_url: input.startUrl,
      stealth: true,
      telemetry: { enabled: false },
      timeout_seconds: input.timeoutSeconds ?? 900,
      profile: input.profileId
        ? { id: input.profileId, save_changes: true }
        : undefined,
    });
    return {
      id: browser.session_id,
      liveViewUrl:
        "browser_live_view_url" in browser &&
        typeof browser.browser_live_view_url === "string"
          ? browser.browser_live_view_url
          : undefined,
    };
  }

  async execute(input: {
    sessionId: string;
    code: string;
    timeoutSeconds?: number;
  }): Promise<unknown> {
    if (input.code.length > 50_000)
      throw new Error("Browser program is too large.");
    const result = await this.#client.browsers.playwright.execute(
      input.sessionId,
      {
        code: input.code,
        timeout_sec: Math.min(input.timeoutSeconds ?? 30, 30),
      },
    );
    if (!result.success)
      throw new Error(result.error ?? "Kernel browser execution failed.");
    return result.result;
  }

  async destroy(sessionId: string): Promise<void> {
    await this.#client.browsers.deleteByID(sessionId);
  }
}
