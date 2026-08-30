import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkEnvironment,
  envFileValues,
  normalizePublicAppUrl,
  parseSupabaseApiKeys,
  setupActions,
} from "../src/index";
import { setEnvValues } from "../src/env-file";
import { configureBlooio, ensureBlooioWebhook } from "../src/blooio-setup";
import { startSetupUi, validateSetupWizardValues } from "../src/setup-ui";

const validValues = {
  NEXT_PUBLIC_APP_URL: "https://openinstinct.example",
  NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
  SUPABASE_SECRET_KEY: "sb_secret_example",
  DATABASE_URL:
    "postgresql://postgres.example:password@db.example.test:5432/postgres",
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  BLOOIO_API_KEY: "blooio_example",
  BLOOIO_OWNER_PHONE: "+15555550123",
  OWNER_EMAIL: "owner@example.com",
  AI_PROVIDER: "openai",
  AI_MODEL: "gpt-5.6-sol",
  OPENAI_API_KEY: "openai_example",
  INTERNAL_API_SECRET: "a".repeat(32),
};

describe("agent-friendly setup checks", () => {
  it("normalizes only public HTTPS application URLs", () => {
    expect(normalizePublicAppUrl("https://assistant.example/path")).toBe(
      "https://assistant.example",
    );
    expect(() => normalizePublicAppUrl("http://localhost:3000")).toThrow(
      "public HTTPS",
    );
  });

  it("parses quoted env-file values without exposing them", () => {
    expect(envFileValues('OWNER_EMAIL="owner@example.com"\nEMPTY=\n')).toEqual({
      OWNER_EMAIL: "owner@example.com",
      EMPTY: "",
    });
  });

  it("does not require the webhook secret during bootstrap", () => {
    const checks = checkEnvironment({
      values: validValues,
      target: "vercel",
      phase: "bootstrap",
    });
    expect(checks.every((check) => check.ok)).toBe(true);
    expect(checks.some((check) => check.name.includes("WEBHOOK"))).toBe(false);
  });

  it("does not block deployment on post-deploy iMessage setup", () => {
    const checks = checkEnvironment({
      values: {
        ...validValues,
        BLOOIO_API_KEY: undefined,
        BLOOIO_OWNER_PHONE: undefined,
      },
      target: "vercel",
      phase: "bootstrap",
    });
    expect(checks.every((check) => check.ok)).toBe(true);
    expect(checks.some((check) => check.name.includes("BLOOIO"))).toBe(false);
  });

  it("accepts a temporary local app URL for bootstrap but not readiness", () => {
    const values = {
      ...validValues,
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    };
    const bootstrap = checkEnvironment({
      values,
      target: "vercel",
      phase: "bootstrap",
    });
    expect(bootstrap.every((check) => check.ok)).toBe(true);
    expect(
      bootstrap.some(
        (check) => check.name === "env:NEXT_PUBLIC_APP_URL:deployment",
      ),
    ).toBe(false);

    const ready = checkEnvironment({
      values: { ...values, BLOOIO_WEBHOOK_SECRET: "webhook-secret" },
      target: "vercel",
      phase: "ready",
    });
    expect(ready).toContainEqual({
      name: "env:NEXT_PUBLIC_APP_URL:deployment",
      ok: false,
      detail: "must be a public HTTPS URL for this target",
    });
  });

  it("requires the webhook secret when checking readiness", () => {
    const checks = checkEnvironment({
      values: validValues,
      target: "vercel",
      phase: "ready",
    });
    expect(checks).toContainEqual({
      name: "env:BLOOIO_WEBHOOK_SECRET",
      ok: false,
      detail: "missing",
    });
  });

  it("validates values and requires the selected direct provider key", () => {
    const checks = checkEnvironment({
      values: {
        ...validValues,
        BLOOIO_OWNER_PHONE: "555",
        OPENAI_API_KEY: undefined,
      },
      target: "docker",
      phase: "ready",
    });
    expect(checks).toContainEqual({
      name: "env:BLOOIO_OWNER_PHONE",
      ok: false,
      detail: "invalid",
    });
    expect(checks).toContainEqual({
      name: "env:OPENAI_API_KEY",
      ok: false,
      detail: "missing",
    });
  });

  it("supports OpenRouter fallback without requiring AI Gateway", () => {
    const checks = checkEnvironment({
      values: {
        ...validValues,
        AI_FALLBACK_PROVIDER: "openrouter",
        AI_FALLBACK_MODEL: "openai/gpt-5.6-luna",
        OPENROUTER_API_KEY: "openrouter_example",
      },
      target: "docker",
      phase: "bootstrap",
    });
    expect(checks.every((check) => check.ok)).toBe(true);
    expect(
      checks.some((check) => check.name === "env:AI_GATEWAY_API_KEY"),
    ).toBe(false);
  });

  it("requires both fallback fields and rejects a duplicate fallback", () => {
    const missingModel = checkEnvironment({
      values: { ...validValues, AI_FALLBACK_PROVIDER: "openai" },
      target: "docker",
      phase: "bootstrap",
    });
    expect(missingModel).toContainEqual({
      name: "env:AI_FALLBACK_MODEL",
      ok: false,
      detail: "missing",
    });

    const duplicate = checkEnvironment({
      values: {
        ...validValues,
        AI_FALLBACK_PROVIDER: "openai",
        AI_FALLBACK_MODEL: validValues.AI_MODEL,
      },
      target: "docker",
      phase: "bootstrap",
    });
    expect(duplicate).toContainEqual({
      name: "env:ai-fallback",
      ok: false,
      detail: "fallback must differ from the primary model",
    });
  });

  it("describes hosted mutations and browser fallback for an agent", () => {
    const actions = setupActions("vercel");
    expect(actions[0]).toMatchObject({
      id: "provision-supabase",
      preferredTool: "supabase-mcp",
      fallbackTool: "computer-use",
      mutatesExternalState: true,
    });
    expect(actions.some((action) => action.id === "configure-scheduler")).toBe(
      true,
    );
    expect(actions.some((action) => action.id === "deploy-scheduler")).toBe(
      false,
    );
    expect(actions.some((action) => action.id === "capture-app-url")).toBe(
      true,
    );
    expect(
      actions.some((action) => action.id === "sync-final-environment"),
    ).toBe(true);
    expect(
      actions.findIndex((action) => action.id === "capture-app-url"),
    ).toBeLessThan(
      actions.findIndex((action) => action.id === "configure-supabase-auth"),
    );
    expect(
      actions.findIndex((action) => action.id === "configure-supabase-auth"),
    ).toBeLessThan(actions.findIndex((action) => action.id === "deploy-final"));
    expect(
      setupActions("vercel-cloudflare").some(
        (action) => action.id === "deploy-scheduler",
      ),
    ).toBe(true);
    expect(
      setupActions("vercel-pro").find((action) => action.id === "deploy-final"),
    ).toMatchObject({
      command: "vercel deploy --prod --local-config vercel.pro.json",
    });
    expect(
      actions.find((action) => action.id === "setup-blooio-account"),
    ).toMatchObject({
      preferredTool: "user",
      browserUrl: "https://app.blooio.com",
    });
    expect(
      actions.find((action) => action.id === "register-blooio-webhook"),
    ).toMatchObject({
      confirmation: "required-before-webhook-registration",
    });
  });

  it("resolves setup actions from existing configuration", () => {
    const actions = setupActions("vercel", {
      NEXT_PUBLIC_APP_URL: "https://assistant.example",
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      BLOOIO_API_KEY: "blooio-secret",
      BLOOIO_WEBHOOK_SECRET: "whsec-secret",
      BLOOIO_OWNER_PHONE: "+15555550123",
    });
    expect(
      actions.find((action) => action.id === "provision-supabase"),
    ).toHaveProperty("status", "complete");
    expect(
      actions.find((action) => action.id === "setup-blooio-account"),
    ).toHaveProperty("status", "complete");
    expect(
      actions.find((action) => action.id === "register-blooio-webhook"),
    ).toHaveProperty("status", "complete");
    expect(
      actions.find((action) => action.id === "verify-ready"),
    ).toHaveProperty("status", "complete");
  });

  it("extracts current or legacy Supabase API key shapes", () => {
    expect(
      parseSupabaseApiKeys([
        { type: "publishable", api_key: "sb_publishable_example" },
        { type: "secret", api_key: "sb_secret_example" },
      ]),
    ).toEqual({
      publishableKey: "sb_publishable_example",
      secretKey: "sb_secret_example",
    });
    expect(
      parseSupabaseApiKeys({
        api_keys: [
          { name: "anon", api_key: "legacy_anon" },
          { name: "service_role", api_key: "legacy_service" },
        ],
      }),
    ).toEqual({
      publishableKey: "legacy_anon",
      secretKey: "legacy_service",
    });
  });

  it("quotes env values safely and keeps the file owner-only", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openinstinct-cli-"));
    const envPath = join(directory, ".env.local");
    await setEnvValues(envPath, {
      OWNER_EMAIL: "owner+setup@example.com",
      BLOOIO_API_KEY: "key#with spaces",
    });
    expect(envFileValues(await readFile(envPath, "utf8"))).toMatchObject({
      OWNER_EMAIL: "owner+setup@example.com",
      BLOOIO_API_KEY: "key#with spaces",
    });
    expect((await stat(envPath)).mode & 0o777).toBe(0o600);
    await expect(
      setEnvValues(envPath, { BLOOIO_API_KEY: "unsafe\nINJECTED=true" }),
    ).rejects.toThrow("line breaks");
  });

  it("validates Google OAuth as a complete group", async () => {
    const incomplete = await validateSetupWizardValues(
      new URLSearchParams({ GOOGLE_CLIENT_ID: "client-id" }),
      {},
    );
    expect(incomplete.errors).toContain(
      "Google OAuth requires the client ID, client secret, and redirect URL together.",
    );
    const complete = await validateSetupWizardValues(
      new URLSearchParams({
        GOOGLE_CLIENT_ID: "client-id",
        GOOGLE_CLIENT_SECRET: "client-secret",
        GOOGLE_REDIRECT_URI:
          "https://openinstinct.example/api/connectors/google/callback",
      }),
      {},
    );
    expect(complete.errors).toEqual([]);
  });

  it("verifies a user-managed Blooio account and captures its only channel", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openinstinct-blooio-"));
    const envPath = join(directory, ".env.local");
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "ch_1",
                type: "blooio",
                address: "+15555550100",
                status: "active",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    await expect(
      configureBlooio({
        envPath,
        apiKey: "blooio-secret",
        fetch: request as typeof fetch,
      }),
    ).resolves.toMatchObject({ selectedChannelId: "ch_1" });
    expect(envFileValues(await readFile(envPath, "utf8"))).toMatchObject({
      BLOOIO_API_KEY: "blooio-secret",
      BLOOIO_CHANNEL_ID: "ch_1",
    });
  });

  it("recovers an existing Blooio webhook instead of creating a duplicate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openinstinct-webhook-"));
    const envPath = join(directory, ".env.local");
    await setEnvValues(envPath, { BLOOIO_API_KEY: "blooio-secret" });
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "wh_1",
                url: "https://assistant.example/api/webhooks/blooio",
                status: "active",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { signing_secret: "whsec_recovered" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    await expect(
      ensureBlooioWebhook({
        envPath,
        appUrl: "https://assistant.example",
        fetch: request as typeof fetch,
      }),
    ).resolves.toMatchObject({ operation: "rotated", webhookId: "wh_1" });
    expect(
      envFileValues(await readFile(envPath, "utf8")).BLOOIO_WEBHOOK_SECRET,
    ).toBe("whsec_recovered");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("never renders stored secrets and rejects cross-origin form posts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openinstinct-ui-"));
    const envPath = join(directory, ".env.local");
    await setEnvValues(envPath, { BLOOIO_API_KEY: "never-render-this" });
    const ui = await startSetupUi({ envPath, port: 0 });
    try {
      const page = await (await fetch(ui.url)).text();
      expect(page).not.toContain("never-render-this");
      expect(page).toContain("Configured — leave blank to keep it");
      expect(page).toContain("Scheduling is handled inside Supabase");
      expect(page).toContain("Advanced deployment options");
      expect(page).toContain("Finish Blooio");
      expect(page).toContain("Setup plan");
      const csrf = page.match(/name="csrf" value="([^"]+)"/u)?.[1];
      expect(csrf).toBeTruthy();
      const response = await fetch(`${ui.url}/save`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://attacker.example",
        },
        body: new URLSearchParams({
          csrf: csrf ?? "",
          OWNER_EMAIL: "owner@example.com",
        }),
      });
      expect(response.status).toBe(403);
      expect(
        envFileValues(await readFile(envPath, "utf8")).OWNER_EMAIL,
      ).toBeUndefined();
      const saved = await fetch(`${ui.url}/save`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ui.url,
        },
        body: new URLSearchParams({
          csrf: csrf ?? "",
          OWNER_EMAIL: "owner@example.com",
          BLOOIO_API_KEY: "",
        }),
      });
      expect(saved.status).toBe(200);
      expect(envFileValues(await readFile(envPath, "utf8"))).toMatchObject({
        OWNER_EMAIL: "owner@example.com",
        BLOOIO_API_KEY: "never-render-this",
      });
      expect(await saved.text()).not.toContain("never-render-this");
    } finally {
      await ui.close();
    }
  });
});
