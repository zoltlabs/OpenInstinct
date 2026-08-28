import { describe, expect, it } from "vitest";
import { readServerEnvironment, serverEnvironmentSchema } from "../src/env";

const baseEnvironment = {
  NEXT_PUBLIC_APP_URL: "https://openinstinct.example",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable_example",
  SUPABASE_SECRET_KEY: "secret_example",
  DATABASE_URL: "postgresql://owner:password@db.example.com:5432/postgres",
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
  BLOOIO_API_KEY: "blooio_example",
  BLOOIO_OWNER_PHONE: "+15555550123",
  OWNER_EMAIL: "owner@example.com",
  AI_PROVIDER: "openai",
  AI_MODEL: "gpt-example",
  OPENAI_API_KEY: "openai_example",
  INTERNAL_API_SECRET: "a".repeat(32),
};

describe("AI provider environment", () => {
  it("requires only the selected direct provider credential", () => {
    expect(serverEnvironmentSchema.safeParse(baseEnvironment).success).toBe(
      true,
    );
    const missing = serverEnvironmentSchema.safeParse({
      ...baseEnvironment,
      OPENAI_API_KEY: undefined,
    });
    expect(missing.success).toBe(false);
    if (!missing.success)
      expect(
        missing.error.issues.some(
          (issue) => issue.path[0] === "OPENAI_API_KEY",
        ),
      ).toBe(true);
  });

  it("treats blank optional variables from env files as unset", () => {
    expect(
      readServerEnvironment({
        ...baseEnvironment,
        AI_GATEWAY_API_KEY: "",
        AI_FALLBACK_PROVIDER: "",
        AI_FALLBACK_MODEL: "",
        ANTHROPIC_API_KEY: "",
      }).AI_PROVIDER,
    ).toBe("openai");
  });

  it("accepts OpenRouter or Vercel Gateway as explicit fallbacks", () => {
    expect(
      serverEnvironmentSchema.safeParse({
        ...baseEnvironment,
        AI_FALLBACK_PROVIDER: "openrouter",
        AI_FALLBACK_MODEL: "openai/gpt-example",
        OPENROUTER_API_KEY: "openrouter_example",
      }).success,
    ).toBe(true);
    expect(
      serverEnvironmentSchema.safeParse({
        ...baseEnvironment,
        AI_FALLBACK_PROVIDER: "vercel-gateway",
        AI_FALLBACK_MODEL: "openai/gpt-example",
        VERCEL_OIDC_TOKEN: "oidc_example",
      }).success,
    ).toBe(true);
  });

  it("requires paired, non-duplicate fallback settings", () => {
    expect(
      serverEnvironmentSchema.safeParse({
        ...baseEnvironment,
        AI_FALLBACK_PROVIDER: "openrouter",
        OPENROUTER_API_KEY: "openrouter_example",
      }).success,
    ).toBe(false);
    expect(
      serverEnvironmentSchema.safeParse({
        ...baseEnvironment,
        AI_FALLBACK_PROVIDER: "openai",
        AI_FALLBACK_MODEL: baseEnvironment.AI_MODEL,
      }).success,
    ).toBe(false);
  });

  it("requires a secure base URL for compatible providers", () => {
    expect(
      serverEnvironmentSchema.safeParse({
        ...baseEnvironment,
        AI_PROVIDER: "openai-compatible",
        OPENAI_API_KEY: undefined,
        AI_COMPATIBLE_BASE_URL: "http://models.example.com/v1",
      }).success,
    ).toBe(false);
    expect(
      serverEnvironmentSchema.safeParse({
        ...baseEnvironment,
        AI_PROVIDER: "openai-compatible",
        OPENAI_API_KEY: undefined,
        AI_COMPATIBLE_BASE_URL: "http://127.0.0.1:1234/v1",
      }).success,
    ).toBe(true);
  });
});
