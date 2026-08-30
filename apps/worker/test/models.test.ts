import { describe, expect, it, vi } from "vitest";
import type { ServerEnvironment } from "@openinstinct/runtime";
import {
  createAssistantModel,
  createProviderModel,
  type ResolvedLanguageModel,
  withFallbackModel,
} from "../src/models";
import { previewAssistantMessage } from "../src/preview";

const environment = {
  NEXT_PUBLIC_APP_URL: "https://openinstinct.example",
  AI_PROVIDER: "openai",
  AI_MODEL: "gpt-example",
  OPENAI_API_KEY: "openai_example",
  ANTHROPIC_API_KEY: "anthropic_example",
  GOOGLE_GENERATIVE_AI_API_KEY: "google_example",
  OPENROUTER_API_KEY: "openrouter_example",
  AI_GATEWAY_API_KEY: "gateway_example",
  AI_COMPATIBLE_BASE_URL: "https://models.example.com/v1",
  AI_COMPATIBLE_API_KEY: "compatible_example",
} as ServerEnvironment;

const generationResult = {
  content: [{ type: "text" as const, text: "fallback" }],
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage: {
    inputTokens: {
      total: 1,
      noCache: 1,
      cacheRead: 0,
      cacheWrite: 0,
    },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
  warnings: [],
};

describe("assistant model selection", () => {
  it.each([
    ["openai", "openai.responses"],
    ["anthropic", "anthropic.messages"],
    ["google", "google.generative-ai"],
    ["openrouter", "openrouter.chat"],
    ["vercel-gateway", "gateway"],
    ["openai-compatible", "openai-compatible.chat"],
  ] as const)("constructs the %s provider directly", (provider, expected) => {
    expect(
      createProviderModel(environment, provider, "model-example").provider,
    ).toBe(expected);
  });

  it("uses an explicit fallback for one failed generation", async () => {
    const fallbackGenerate = vi.fn(async () => generationResult);
    const primary = {
      specificationVersion: "v4",
      provider: "primary",
      modelId: "primary-model",
      supportedUrls: {},
      doGenerate: vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
      doStream: vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
    } satisfies ResolvedLanguageModel;
    const fallback = {
      specificationVersion: "v4",
      provider: "fallback",
      modelId: "fallback-model",
      supportedUrls: {},
      doGenerate: fallbackGenerate,
      doStream: vi.fn(async () => {
        throw new Error("not used");
      }),
    } satisfies ResolvedLanguageModel;

    const result = await withFallbackModel(primary, fallback).doGenerate({
      prompt: [],
    });
    expect(result.content).toEqual(generationResult.content);
    expect(fallbackGenerate).toHaveBeenCalledOnce();
  });

  it("does not silently configure a fallback", () => {
    const selection = createAssistantModel(environment);
    expect(selection.configuredId).toBe("openai:gpt-example");
    expect(selection.model.provider).toBe("openai.responses");
  });

  it("previews a response without exposing tools or side effects", async () => {
    const generate = vi.fn(async () => generationResult);
    const model = {
      specificationVersion: "v4",
      provider: "preview",
      modelId: "preview-model",
      supportedUrls: {},
      doGenerate: generate,
      doStream: vi.fn(async () => {
        throw new Error("not used");
      }),
    } satisfies ResolvedLanguageModel;

    await expect(
      previewAssistantMessage({ model, message: "What can you do?" }),
    ).resolves.toBe("fallback");
    expect(generate).toHaveBeenCalledOnce();
    expect(JSON.stringify(generate.mock.calls[0])).toContain(
      "local model-only preview",
    );
  });
});
