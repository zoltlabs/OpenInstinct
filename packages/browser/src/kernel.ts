import Kernel, { toFile } from "@onkernel/sdk";
import { z } from "zod";
import {
  browserCapabilitySchema,
  browserInteractionSchema,
  type BrowserActionResult,
  type BrowserAuthenticationVerification,
  type BrowserCapabilities,
  type BrowserCredentialInjection,
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
  tabCount: z.number().int().min(1).max(100).default(1),
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
      networkReadOnlyIsolation: false,
      sessionLookupByCorrelation: true,
      startIdempotency: true,
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
    correlationId?: string;
    readOnly?: boolean;
  }): Promise<BrowserSession> {
    const timeout = Math.min(
      Math.max(input.timeoutSeconds ?? 900, 10),
      259_200,
    );
    const browser = await this.#client.browsers.create({
      start_url: input.readOnly ? "about:blank" : input.startUrl,
      headless: false,
      stealth: true,
      telemetry: { enabled: false },
      timeout_seconds: timeout,
      ...(input.correlationId
        ? {
            invocation_id: input.correlationId,
            name: `openinstinct-${input.correlationId}`,
          }
        : {}),
      ...(input.readOnly ? { network: { private_hosts: [] } } : {}),
      profile: input.profileId
        ? { id: input.profileId, save_changes: !input.readOnly }
        : undefined,
      tags: {
        purpose: input.purpose,
        ...(input.correlationId
          ? { openinstinct_correlation: input.correlationId }
          : {}),
        ...(input.readOnly ? { openinstinct_read_only: "true" } : {}),
      },
    });
    return safeSession(browser, timeout);
  }
  async findSessions(input: {
    correlationId: string;
    includeClosed?: boolean;
  }): Promise<readonly BrowserSession[]> {
    const sessions: BrowserSession[] = [];
    for await (const browser of this.#client.browsers.list({
      limit: 100,
      status: input.includeClosed ? "all" : "active",
      tags: { openinstinct_correlation: input.correlationId },
    })) {
      sessions.push(safeSession(browser, browser.timeout_seconds));
      if (sessions.length >= 100) break;
    }
    return sessions;
  }
  async installReadOnlyGuards(
    sessionId: string,
    rawAllowedOrigins: readonly string[],
  ): Promise<{ installed: boolean; fullyIsolated: boolean }> {
    const allowedOrigins = rawAllowedOrigins.map((value) => {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.origin !== value)
        throw new Error(
          "Read-only browser origins must be exact HTTPS origins.",
        );
      return url.origin;
    });
    const encodedOrigins = JSON.stringify([
      ...new Set(allowedOrigins),
    ]).replaceAll("<", "\\u003c");
    await this.#executeFixed(
      sessionId,
      `const allowed=new Set(${encodedOrigins});
await page.context().route("**/*", async route => {
  const request=route.request();
  let target;
  try { target=new URL(request.url()); } catch { await route.abort("blockedbyclient"); return; }
  const method=request.method().toUpperCase();
  if(!allowed.has(target.origin) || !["GET","HEAD","OPTIONS"].includes(method)) { await route.abort("blockedbyclient"); return; }
  await route.continue();
});
await page.context().addInitScript(() => {
  const blocked=() => { throw new Error("Blocked by OpenInstinct read-only policy"); };
  Object.defineProperty(navigator,"sendBeacon",{value:() => false,configurable:false});
  Object.defineProperty(navigator,"serviceWorker",{value:undefined,configurable:false});
  Object.defineProperty(window,"WebSocket",{value:class { constructor(){ blocked(); } },configurable:false});
  Object.defineProperty(window,"EventSource",{value:class { constructor(){ blocked(); } },configurable:false});
  Object.defineProperty(window,"open",{value:blocked,configurable:false});
});
return { installed:true };`,
    );
    // Playwright routing and page-level guards cannot prove coverage for every
    // browser/network path (notably existing service workers), so callers must
    // never treat this adapter as strong isolation for authenticated profiles.
    return { installed: true, fullyIsolated: false };
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
        `return { url: page.url(), title: (await page.title()).slice(0, 2000), text: (await page.locator("body").innerText()).slice(0, 20000), links: await page.locator("a[href]").evaluateAll(nodes => nodes.slice(0,100).map(node => ({ text: (node.textContent || "").trim().slice(0,1000), href: node.href }))), tabCount: page.context().pages().length };`,
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
else if(action.type==="go_back") await page.goBack({waitUntil:"domcontentloaded"});
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
  async injectCredentialFields(
    sessionId: string,
    input: BrowserCredentialInjection,
  ): Promise<{ completed: true; origin: string }> {
    const origin = new URL(input.exactOrigin);
    if (origin.protocol !== "https:" || origin.origin !== input.exactOrigin)
      throw new Error("Credential injection requires an exact HTTPS origin.");
    if (input.frameOrigin && input.frameOrigin !== input.exactOrigin)
      throw new Error("Cross-origin credential frames are not supported.");
    if (
      input.username.byteLength === 0 ||
      input.username.byteLength > 4_000 ||
      input.password.byteLength === 0 ||
      input.password.byteLength > 40_000 ||
      !Number.isInteger(input.timeoutMs) ||
      input.timeoutMs < 1_000 ||
      input.timeoutMs > 60_000
    )
      throw new Error("Credential fields exceed the injection boundary.");
    const username = Buffer.from(input.username).toString("utf8");
    const password = Buffer.from(input.password).toString("utf8");
    const value = JSON.stringify({
      exactOrigin: input.exactOrigin,
      usernameSelector: input.usernameSelector,
      passwordSelector: input.passwordSelector,
      submitSelector: input.submitSelector,
      username,
      password,
    }).replaceAll("<", "\\u003c");
    try {
      return z
        .object({ completed: z.literal(true), origin: z.string().url() })
        .parse(
          await this.#executeFixed(
            sessionId,
            `const input=${value};
const currentOrigin=new URL(page.url()).origin;
if(currentOrigin!==input.exactOrigin) throw new Error("origin_mismatch");
let username=page.locator(input.usernameSelector);
if(await username.count()!==1) throw new Error("ambiguous_credential_field");
const usernameFacts=await username.evaluate(node=>({tag:node.tagName.toLowerCase(),type:(node.getAttribute("type")||"").toLowerCase(),autocomplete:(node.getAttribute("autocomplete")||"").toLowerCase()}));
if(usernameFacts.tag!=="input" || !["","text","email"].includes(usernameFacts.type) || usernameFacts.autocomplete==="one-time-code") throw new Error("invalid_username_field");
const fillExact=async(locator,value)=>locator.evaluate((node,args)=>{
  const view=node.ownerDocument.defaultView;
  if(!view || view.location.origin!==args.origin) throw new Error("field_origin_mismatch");
  const setter=Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype,"value")?.set;
  if(!setter) throw new Error("input_setter_unavailable");
  setter.call(node,args.value);
  node.dispatchEvent(new view.Event("input",{bubbles:true}));
  node.dispatchEvent(new view.Event("change",{bubbles:true}));
},{origin:input.exactOrigin,value});
await fillExact(username,input.username);
if(new URL(page.url()).origin!==input.exactOrigin) throw new Error("origin_changed_after_username");
const password=page.locator(input.passwordSelector);
if(await password.count()!==1) throw new Error("ambiguous_credential_field");
const passwordFacts=await password.evaluate(node=>({origin:node.ownerDocument.defaultView?.location.origin,tag:node.tagName.toLowerCase(),type:(node.getAttribute("type")||"").toLowerCase(),autocomplete:(node.getAttribute("autocomplete")||"").toLowerCase()}));
if(passwordFacts.origin!==input.exactOrigin || passwordFacts.tag!=="input" || passwordFacts.type!=="password" || passwordFacts.autocomplete==="one-time-code") throw new Error("invalid_password_field");
await fillExact(password,input.password);
if(new URL(page.url()).origin!==input.exactOrigin) throw new Error("origin_changed_after_password");
if(input.submitSelector) {
  const submit=page.locator(input.submitSelector);
  if(await submit.count()!==1) throw new Error("ambiguous_submit_control");
  const submitOrigin=await submit.evaluate(node=>node.ownerDocument.defaultView?.location.origin);
  if(submitOrigin!==input.exactOrigin || new URL(page.url()).origin!==input.exactOrigin) throw new Error("submit_origin_mismatch");
  await submit.click();
}
return {completed:true,origin:new URL(page.url()).origin};`,
            Math.min(Math.max(Math.ceil(input.timeoutMs / 1_000), 1), 30),
          ),
        );
    } finally {
      // JavaScript strings cannot be reliably zeroized. Keep their lifetime
      // confined to this provider call and never include them in errors/results.
      void username;
      void password;
    }
  }
  async screenshot(sessionId: string): Promise<Uint8Array> {
    const response =
      await this.#client.browsers.computer.captureScreenshot(sessionId);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 10_000_000)
      throw new Error("Browser screenshot exceeds the size limit.");
    return bytes;
  }
  async captureRedactedScreenshot(_sessionId: string): Promise<{
    omittedReason: string;
    redactionVersion: string;
  }> {
    // DOM masking cannot safely redact sensitive text rendered outside form
    // fields, canvases, videos, or cross-origin frames. Until a reviewed OCR
    // redactor is available, withhold screenshots from adaptive execution.
    return {
      omittedReason: "ocr_redaction_unavailable",
      redactionVersion: "withheld-v1",
    };
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
  async #executeFixed(
    sessionId: string,
    code: string,
    timeoutSeconds = 30,
  ): Promise<unknown> {
    const timeoutMs = timeoutSeconds * 1_000 + 2_000;
    const result = await this.#client.browsers.playwright.execute(
      sessionId,
      {
        code,
        timeout_sec: timeoutSeconds,
      },
      {
        maxRetries: 0,
        timeout: timeoutMs,
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
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
