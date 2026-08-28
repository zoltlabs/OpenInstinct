import { describe, expect, it } from "vitest";
import {
  checkEnvironment,
  envFileValues,
  parseSupabaseApiKeys,
  setupActions,
} from "../src/index";

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
  AI_MODEL: "openai/gpt-5.6-sol",
  INTERNAL_API_SECRET: "a".repeat(32),
};

describe("agent-friendly setup checks", () => {
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

  it("validates values and requires gateway credentials off Vercel", () => {
    const checks = checkEnvironment({
      values: { ...validValues, BLOOIO_OWNER_PHONE: "555" },
      target: "docker",
      phase: "bootstrap",
    });
    expect(checks).toContainEqual({
      name: "env:BLOOIO_OWNER_PHONE",
      ok: false,
      detail: "invalid",
    });
    expect(checks).toContainEqual({
      name: "env:AI_GATEWAY_API_KEY",
      ok: false,
      detail: "missing",
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
    expect(actions.some((action) => action.id === "deploy-scheduler")).toBe(
      true,
    );
    expect(
      actions.some((action) => action.id === "sync-vercel-environment"),
    ).toBe(true);
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
});
