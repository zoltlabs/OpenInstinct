import Kernel, { toFile } from "@onkernel/sdk";
import { z } from "zod";
import {
  browserCapabilitySchema,
  browserInteractionSchema,
  type BrowserActionResult,
  type BrowserAuthenticationVerification,
  type BrowserCapabilities,
  type BrowserFile,
  type BrowserHealth,
  type BrowserInteraction,
  type BrowserObservation,
  type BrowserProfile,
  type BrowserProvider,
  type BrowserSession,
  type BrowserTakeoverCapability,
} from "./provider";

const observationSchema = z.object({
  url: z.string().url(),
  title: z.string().max(2_000),
  text: z.string().max(20_000),
  links: z
    .array(z.object({ text: z.string().max(1_000), href: z.string().url() }))
    .max(100),
});

export class KernelBrowserProvider implements BrowserProvider {
  readonly #client: Kernel;
  constructor(apiKey: string, client?: Kernel) {
    this.#client =
      client ?? new Kernel({ apiKey, logLevel: "off", maxRetries: 2 });
  }

  async capabilities(): Promise<BrowserCapabilities> {
    return browserCapabilitySchema.parse({
      profiles: true,
      reconnect: true,
      checkpoint: false,
      structuredObservation: true,
      screenshots: true,
      fileTransfer: true,
      humanTakeover: true,
      replayControl: true,
      maxSessionSeconds: 259_200,
    });
  }

  async createProfile(input: { name: string }): Promise<BrowserProfile> {
    return safeProfile(
      await this.#client.profiles.create({ name: input.name }),
    );
  }
  async listProfiles(input?: {
    exactName?: string;
  }): Promise<readonly BrowserProfile[]> {
    const profiles: BrowserProfile[] = [];
    for await (const profile of this.#client.profiles.list({
      limit: 100,
      ...(input?.exactName ? { name: input.exactName } : {}),
    })) {
      const safe = safeProfile(profile);
      if (!input?.exactName || safe.name === input.exactName)
        profiles.push(safe);
      if (profiles.length >= 100) break;
    }
    return profiles;
  }
  async inspectProfile(profileId: string): Promise<BrowserProfile> {
    return safeProfile(await this.#client.profiles.retrieve(profileId));
  }
  async deleteProfile(profileId: string): Promise<{ verified: boolean }> {
    try {
      await this.#client.profiles.delete(profileId);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    try {
      await this.#client.profiles.retrieve(profileId);
      return { verified: false };
    } catch (error) {
      if (isNotFound(error)) return { verified: true };
      throw error;
    }
  }
  async profileHealth(profileId: string): Promise<BrowserHealth> {
    try {
      await this.inspectProfile(profileId);
      return health(true, "available");
    } catch (error) {
      if (isNotFound(error))
        return health(false, "missing", "Provider profile was not found.");
      return health(false, "error", "Provider profile health check failed.");
    }
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
    const timeout = Math.min(
      Math.max(input.timeoutSeconds ?? 900, 10),
      259_200,
    );
    const browser = await this.#client.browsers.create({
      start_url: input.startUrl,
      headless: false,
      stealth: true,
      telemetry: { enabled: false },
      timeout_seconds: timeout,
      profile: input.profileId
        ? { id: input.profileId, save_changes: true }
        : undefined,
      tags: { purpose: input.purpose },
    });
    return safeSession(browser, timeout);
  }
  async reconnectSession(sessionId: string): Promise<BrowserSession> {
    const browser = await this.#client.browsers.retrieve(sessionId);
    return safeSession(browser, browser.timeout_seconds);
  }
  async sessionHealth(sessionId: string): Promise<BrowserHealth> {
    try {
      const browser = await this.#client.browsers.retrieve(sessionId, {
        include_deleted: true,
      });
      return browser.deleted_at
        ? health(false, "closed")
        : health(true, "active");
    } catch (error) {
      return isNotFound(error)
        ? health(false, "missing")
        : health(false, "error", "Provider session health check failed.");
    }
  }
  async checkpointSession(
    _sessionId: string,
  ): Promise<{ checkpointed: boolean; reason?: string }> {
    return {
      checkpointed: false,
      reason: "Kernel saves profile changes when the session closes.",
    };
  }
  async closeSession(sessionId: string): Promise<void> {
    try {
      await this.#client.browsers.deleteByID(sessionId);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async observe(sessionId: string): Promise<BrowserObservation> {
    return observationSchema.parse(
      await this.#executeFixed(
        sessionId,
        `return { url: page.url(), title: (await page.title()).slice(0, 2000), text: (await page.locator("body").innerText()).slice(0, 20000), links: await page.locator("a[href]").evaluateAll(nodes => nodes.slice(0,100).map(node => ({ text: (node.textContent || "").trim().slice(0,1000), href: node.href }))) };`,
      ),
    );
  }
  async verifyAuthentication(
    sessionId: string,
    exactOrigin: string,
  ): Promise<BrowserAuthenticationVerification> {
    const observation = await this.observe(sessionId);
    const sameOrigin = new URL(observation.url).origin === exactOrigin;
    return {
      verified: false,
      method: "unsupported_generic_kernel_profile_check",
      checkedAt: new Date().toISOString(),
      reason: sameOrigin
        ? "Exact origin is necessary but does not prove an authenticated session."
        : "The browser is outside the enrolled origin.",
    };
  }
  async executeAction(
    sessionId: string,
    raw: BrowserInteraction,
  ): Promise<BrowserActionResult> {
    const action = browserInteractionSchema.parse(raw);
    const value = JSON.stringify(action).replaceAll("<", "\\u003c");
    const result = await this.#executeFixed(
      sessionId,
      `const action=${value};
if(action.type==="navigate") await page.goto(action.url,{waitUntil:"domcontentloaded"});
else if(action.type==="click") await page.locator(action.selector).click();
else if(action.type==="type_text") await page.locator(action.selector).fill(action.text);
else if(action.type==="select") await page.locator(action.selector).selectOption(action.value);
else if(action.type==="scroll") await page.mouse.wheel(0,action.deltaY);
else if(action.type==="press_key") await page.keyboard.press(action.key);
else if(action.type==="wait") await page.waitForTimeout(action.milliseconds);
else if(action.type==="open_tab") { const p=await page.context().newPage(); if(action.url) await p.goto(action.url,{waitUntil:"domcontentloaded"}); }
else if(action.type==="close_tab") { const pages=page.context().pages(); if(pages[action.index]) await pages[action.index].close(); }
else if(action.type==="switch_tab") { const pages=page.context().pages(); if(!pages[action.index]) throw new Error("Tab is unavailable"); await pages[action.index].bringToFront(); }
else if(action.type==="dialog") { page.once("dialog", d => action.response==="accept" ? d.accept() : d.dismiss()); }
return { completed:true, url:page.url(), title:(await page.title()).slice(0,2000) };`,
    );
    return z
      .object({
        completed: z.literal(true),
        url: z.string().url(),
        title: z.string().max(2_000),
      })
      .parse(result);
  }
  async screenshot(sessionId: string): Promise<Uint8Array> {
    const response =
      await this.#client.browsers.computer.captureScreenshot(sessionId);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 10_000_000)
      throw new Error("Browser screenshot exceeds the size limit.");
    return bytes;
  }
  async uploadFile(
    sessionId: string,
    file: BrowserFile,
  ): Promise<{ remotePath: string }> {
    if (file.bytes.byteLength > 25_000_000)
      throw new Error("Browser upload exceeds the size limit.");
    const name = safeFileName(file.name);
    const remotePath = `/tmp/openinstinct/${name}`;
    await this.#client.browsers.fs.upload(sessionId, {
      files: [
        {
          dest_path: remotePath,
          file: await toFile(file.bytes, name, { type: file.mimeType }),
        },
      ],
    });
    return { remotePath };
  }
  async downloadFile(
    sessionId: string,
    remotePath: string,
    maxBytes: number,
  ): Promise<BrowserFile> {
    if (!remotePath.startsWith("/tmp/openinstinct/"))
      throw new Error(
        "Browser download path is outside the approved directory.",
      );
    const response = await this.#client.browsers.fs.readFile(sessionId, {
      path: remotePath,
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > Math.min(maxBytes, 25_000_000))
      throw new Error("Browser download exceeds the size limit.");
    return {
      name: safeFileName(remotePath.split("/").at(-1) ?? "download"),
      mimeType:
        response.headers.get("content-type") ?? "application/octet-stream",
      bytes,
    };
  }
  async takeover(sessionId: string): Promise<BrowserTakeoverCapability> {
    const browser = await this.#client.browsers.retrieve(sessionId);
    if (!browser.browser_live_view_url)
      throw new Error("Provider live takeover is unavailable.");
    const url = new URL(browser.browser_live_view_url);
    if (url.protocol !== "https:")
      throw new Error("Provider returned an unsafe takeover URL.");
    return {
      url: url.toString(),
      expiresAt: safeSession(browser, browser.timeout_seconds).expiresAt,
    };
  }
  async startReplay(sessionId: string): Promise<{ replayId: string }> {
    const replay = await this.#client.browsers.replays.start(sessionId, {
      max_duration_in_seconds: 300,
      record_audio: false,
    });
    return { replayId: replay.replay_id };
  }
  async stopReplay(sessionId: string, replayId: string): Promise<void> {
    await this.#client.browsers.replays.stop(replayId, { id: sessionId });
  }
  async #executeFixed(sessionId: string, code: string): Promise<unknown> {
    const result = await this.#client.browsers.playwright.execute(sessionId, {
      code,
      timeout_sec: 30,
    });
    if (!result.success) throw new Error("Kernel browser operation failed.");
    return result.result;
  }
}

function safeProfile(profile: {
  id: string;
  name?: string | null;
  created_at: string;
  updated_at?: string;
  last_used_at?: string;
}): BrowserProfile {
  return {
    id: profile.id,
    ...(profile.name ? { name: profile.name } : {}),
    createdAt: profile.created_at,
    ...(profile.updated_at ? { updatedAt: profile.updated_at } : {}),
    ...(profile.last_used_at ? { lastUsedAt: profile.last_used_at } : {}),
  };
}
function safeSession(
  browser: {
    session_id: string;
    created_at: string;
    timeout_seconds: number;
    deleted_at?: string;
    profile?: { id: string };
  },
  timeout: number,
): BrowserSession {
  return {
    id: browser.session_id,
    ...(browser.profile?.id ? { profileId: browser.profile.id } : {}),
    status: browser.deleted_at ? "closed" : "active",
    createdAt: browser.created_at,
    expiresAt: new Date(
      new Date(browser.created_at).getTime() + timeout * 1_000,
    ).toISOString(),
  };
}
function health(
  healthy: boolean,
  status: string,
  reason?: string,
): BrowserHealth {
  return {
    healthy,
    status,
    checkedAt: new Date().toISOString(),
    ...(reason ? { reason } : {}),
  };
}
function safeFileName(value: string): string {
  const name = value.replaceAll(/[^a-zA-Z0-9._-]/gu, "_").slice(0, 200);
  if (!name || name === "." || name === "..")
    throw new Error("Browser file name is invalid.");
  return name;
}
function isNotFound(error: unknown): boolean {
  return (
    error instanceof Kernel.NotFoundError ||
    (typeof error === "object" &&
      error !== null &&
      "status" in error &&
      (error as { status?: number }).status === 404)
  );
}
