import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  createGateway,
  wrapLanguageModel,
  type LanguageModelMiddleware,
} from "ai";
import type { AiProvider, ServerEnvironment } from "@openinstinct/runtime";

export type ModelEnvironment = Pick<
  ServerEnvironment,
  | "NEXT_PUBLIC_APP_URL"
  | "AI_PROVIDER"
  | "AI_MODEL"
  | "AI_FALLBACK_PROVIDER"
  | "AI_FALLBACK_MODEL"
  | "AI_GATEWAY_API_KEY"
  | "OPENAI_API_KEY"
  | "ANTHROPIC_API_KEY"
  | "GOOGLE_GENERATIVE_AI_API_KEY"
  | "OPENROUTER_API_KEY"
  | "AI_COMPATIBLE_BASE_URL"
  | "AI_COMPATIBLE_API_KEY"
>;

export type ResolvedLanguageModel = ReturnType<typeof wrapLanguageModel>;

export interface AssistantModel {
  readonly model: ResolvedLanguageModel;
  readonly configuredId: string;
}

function required(value: string | undefined, name: string): string {
  if (!value)
    throw new Error(`${name} is required for the selected AI provider.`);
  return value;
}

export function createProviderModel(
  env: ModelEnvironment,
  provider: AiProvider,
  modelId: string,
): ResolvedLanguageModel {
  switch (provider) {
    case "openai":
      return createOpenAI({
        apiKey: required(env.OPENAI_API_KEY, "OPENAI_API_KEY"),
      })(modelId);
    case "anthropic":
      return createAnthropic({
        apiKey: required(env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY"),
      })(modelId);
    case "google":
      return createGoogle({
        apiKey: required(
          env.GOOGLE_GENERATIVE_AI_API_KEY,
          "GOOGLE_GENERATIVE_AI_API_KEY",
        ),
      })(modelId);
    case "openrouter":
      return createOpenAICompatible({
        name: "openrouter",
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: required(env.OPENROUTER_API_KEY, "OPENROUTER_API_KEY"),
        headers: {
          "HTTP-Referer": env.NEXT_PUBLIC_APP_URL,
          "X-Title": "OpenInstinct",
        },
      })(modelId);
    case "vercel-gateway":
      return createGateway({ apiKey: env.AI_GATEWAY_API_KEY })(modelId);
    case "openai-compatible":
      return createOpenAICompatible({
        name: "openai-compatible",
        baseURL: required(env.AI_COMPATIBLE_BASE_URL, "AI_COMPATIBLE_BASE_URL"),
        apiKey: env.AI_COMPATIBLE_API_KEY,
      })(modelId);
  }
}

export function withFallbackModel(
  primary: ResolvedLanguageModel,
  fallback: ResolvedLanguageModel,
): ResolvedLanguageModel {
  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate, params }) => {
      try {
        return await doGenerate();
      } catch (error) {
        if (params.abortSignal?.aborted) throw error;
        return fallback.doGenerate(params);
      }
    },
    wrapStream: async ({ doStream, params }) => {
      try {
        return await doStream();
      } catch (error) {
        if (params.abortSignal?.aborted) throw error;
        return fallback.doStream(params);
      }
    },
  };
  return wrapLanguageModel({
    model: primary,
    middleware,
    providerId: `${primary.provider}+fallback`,
  });
}

export function createAssistantModel(env: ModelEnvironment): AssistantModel {
  const primary = createProviderModel(env, env.AI_PROVIDER, env.AI_MODEL);
  const primaryId = `${env.AI_PROVIDER}:${env.AI_MODEL}`;
  if (!env.AI_FALLBACK_PROVIDER || !env.AI_FALLBACK_MODEL)
    return { model: primary, configuredId: primaryId };

  const fallback = createProviderModel(
    env,
    env.AI_FALLBACK_PROVIDER,
    env.AI_FALLBACK_MODEL,
  );
  return {
    model: withFallbackModel(primary, fallback),
    configuredId: `${primaryId}|fallback=${env.AI_FALLBACK_PROVIDER}:${env.AI_FALLBACK_MODEL}`,
  };
}
