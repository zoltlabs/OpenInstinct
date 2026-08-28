import { z } from "zod";

const secureUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "::1"].includes(url.hostname))
    );
  }, "URL must use HTTPS except on loopback development hosts.");
const optionalUrl = secureUrl.optional();

export const aiProviderSchema = z.enum([
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "vercel-gateway",
  "openai-compatible",
]);
export type AiProvider = z.infer<typeof aiProviderSchema>;

const base64Key = z.string().refine((value) => {
  try {
    return (
      Buffer.from(value, "base64").byteLength === 32 &&
      Buffer.from(value, "base64").toString("base64") === value
    );
  } catch {
    return false;
  }
}, "Must be a canonical base64-encoded 32-byte key.");

const databaseUrl = z
  .string()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "postgres:" || protocol === "postgresql:";
  }, "Must be a Postgres connection URL.");

export const environmentFieldSchemas = {
  NEXT_PUBLIC_APP_URL: secureUrl,
  NEXT_PUBLIC_SUPABASE_URL: secureUrl,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_URL: secureUrl,
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SECRET_KEY: z.string().min(1),
  DATABASE_URL: databaseUrl,
  SECRET_ENCRYPTION_KEY: base64Key,
  BLOOIO_API_KEY: z.string().min(1),
  BLOOIO_WEBHOOK_SECRET: z.string().min(1),
  BLOOIO_CHANNEL_ID: z.string().min(1),
  BLOOIO_OWNER_PHONE: z.string().regex(/^\+[1-9][0-9]{7,14}$/),
  OWNER_EMAIL: z.string().email(),
  AI_PROVIDER: aiProviderSchema,
  AI_GATEWAY_API_KEY: z.string().min(1),
  AI_MODEL: z.string().min(1),
  AI_FALLBACK_PROVIDER: aiProviderSchema,
  AI_FALLBACK_MODEL: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1),
  OPENROUTER_API_KEY: z.string().min(1),
  AI_COMPATIBLE_BASE_URL: secureUrl,
  AI_COMPATIBLE_API_KEY: z.string().min(1),
  VERCEL_OIDC_TOKEN: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REDIRECT_URI: secureUrl,
  KERNEL_API_KEY: z.string().min(1),
  INTERNAL_API_SECRET: z.string().min(32),
  CRON_SECRET: z.string().min(16),
  WORKER_URL: secureUrl,
} as const;

const serverEnvironmentBaseSchema = z.object({
  NEXT_PUBLIC_APP_URL: environmentFieldSchemas.NEXT_PUBLIC_APP_URL,
  NEXT_PUBLIC_SUPABASE_URL: environmentFieldSchemas.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
    environmentFieldSchemas.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  SUPABASE_URL: optionalUrl,
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
  SUPABASE_SECRET_KEY: environmentFieldSchemas.SUPABASE_SECRET_KEY,
  DATABASE_URL: environmentFieldSchemas.DATABASE_URL,
  SECRET_ENCRYPTION_KEY: environmentFieldSchemas.SECRET_ENCRYPTION_KEY,
  BLOOIO_API_KEY: environmentFieldSchemas.BLOOIO_API_KEY,
  BLOOIO_WEBHOOK_SECRET:
    environmentFieldSchemas.BLOOIO_WEBHOOK_SECRET.optional(),
  BLOOIO_CHANNEL_ID: environmentFieldSchemas.BLOOIO_CHANNEL_ID.optional(),
  BLOOIO_OWNER_PHONE: environmentFieldSchemas.BLOOIO_OWNER_PHONE,
  OWNER_EMAIL: environmentFieldSchemas.OWNER_EMAIL,
  AI_PROVIDER: environmentFieldSchemas.AI_PROVIDER,
  AI_GATEWAY_API_KEY: environmentFieldSchemas.AI_GATEWAY_API_KEY.optional(),
  AI_MODEL: environmentFieldSchemas.AI_MODEL,
  AI_FALLBACK_PROVIDER: environmentFieldSchemas.AI_FALLBACK_PROVIDER.optional(),
  AI_FALLBACK_MODEL: environmentFieldSchemas.AI_FALLBACK_MODEL.optional(),
  OPENAI_API_KEY: environmentFieldSchemas.OPENAI_API_KEY.optional(),
  ANTHROPIC_API_KEY: environmentFieldSchemas.ANTHROPIC_API_KEY.optional(),
  GOOGLE_GENERATIVE_AI_API_KEY:
    environmentFieldSchemas.GOOGLE_GENERATIVE_AI_API_KEY.optional(),
  OPENROUTER_API_KEY: environmentFieldSchemas.OPENROUTER_API_KEY.optional(),
  AI_COMPATIBLE_BASE_URL:
    environmentFieldSchemas.AI_COMPATIBLE_BASE_URL.optional(),
  AI_COMPATIBLE_API_KEY:
    environmentFieldSchemas.AI_COMPATIBLE_API_KEY.optional(),
  VERCEL_OIDC_TOKEN: environmentFieldSchemas.VERCEL_OIDC_TOKEN.optional(),
  GOOGLE_CLIENT_ID: environmentFieldSchemas.GOOGLE_CLIENT_ID.optional(),
  GOOGLE_CLIENT_SECRET: environmentFieldSchemas.GOOGLE_CLIENT_SECRET.optional(),
  GOOGLE_REDIRECT_URI: optionalUrl,
  KERNEL_API_KEY: environmentFieldSchemas.KERNEL_API_KEY.optional(),
  INTERNAL_API_SECRET: environmentFieldSchemas.INTERNAL_API_SECRET,
  CRON_SECRET: environmentFieldSchemas.CRON_SECRET.optional(),
  WORKER_URL: optionalUrl,
});

function requireProviderConfiguration(
  value: z.infer<typeof serverEnvironmentBaseSchema>,
  provider: AiProvider,
  path: "AI_PROVIDER" | "AI_FALLBACK_PROVIDER",
  context: z.core.$RefinementCtx,
): void {
  const required = (
    name:
      | "OPENAI_API_KEY"
      | "ANTHROPIC_API_KEY"
      | "GOOGLE_GENERATIVE_AI_API_KEY"
      | "OPENROUTER_API_KEY"
      | "AI_COMPATIBLE_BASE_URL",
  ) => {
    if (!value[name])
      context.addIssue({
        code: "custom",
        message: `${name} is required when ${path}=${provider}.`,
        path: [name],
      });
  };

  switch (provider) {
    case "openai":
      required("OPENAI_API_KEY");
      break;
    case "anthropic":
      required("ANTHROPIC_API_KEY");
      break;
    case "google":
      required("GOOGLE_GENERATIVE_AI_API_KEY");
      break;
    case "openrouter":
      required("OPENROUTER_API_KEY");
      break;
    case "vercel-gateway":
      if (!value.AI_GATEWAY_API_KEY && !value.VERCEL_OIDC_TOKEN)
        context.addIssue({
          code: "custom",
          message:
            "AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN is required when using vercel-gateway.",
          path: ["AI_GATEWAY_API_KEY"],
        });
      break;
    case "openai-compatible":
      required("AI_COMPATIBLE_BASE_URL");
      break;
  }
}

export const serverEnvironmentSchema = serverEnvironmentBaseSchema.superRefine(
  (value, context) => {
    requireProviderConfiguration(
      value,
      value.AI_PROVIDER,
      "AI_PROVIDER",
      context,
    );
    if (
      Boolean(value.AI_FALLBACK_PROVIDER) !== Boolean(value.AI_FALLBACK_MODEL)
    )
      context.addIssue({
        code: "custom",
        message:
          "AI_FALLBACK_PROVIDER and AI_FALLBACK_MODEL must be set together.",
        path: [
          value.AI_FALLBACK_PROVIDER
            ? "AI_FALLBACK_MODEL"
            : "AI_FALLBACK_PROVIDER",
        ],
      });
    if (value.AI_FALLBACK_PROVIDER)
      requireProviderConfiguration(
        value,
        value.AI_FALLBACK_PROVIDER,
        "AI_FALLBACK_PROVIDER",
        context,
      );
    if (
      value.AI_FALLBACK_PROVIDER === value.AI_PROVIDER &&
      value.AI_FALLBACK_MODEL === value.AI_MODEL
    )
      context.addIssue({
        code: "custom",
        message: "The fallback must differ from the primary model.",
        path: ["AI_FALLBACK_MODEL"],
      });
  },
);

export type ServerEnvironment = z.infer<typeof serverEnvironmentSchema>;

export function readServerEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): ServerEnvironment {
  const normalized = Object.fromEntries(
    Object.entries(source).map(([name, value]) => [
      name,
      value === "" ? undefined : value,
    ]),
  );
  return serverEnvironmentSchema.parse({
    ...normalized,
    SUPABASE_URL:
      normalized.SUPABASE_URL ?? normalized.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY:
      normalized.SUPABASE_PUBLISHABLE_KEY ??
      normalized.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
}

export const publicEnvironmentSchema = serverEnvironmentBaseSchema.pick({
  NEXT_PUBLIC_APP_URL: true,
  NEXT_PUBLIC_SUPABASE_URL: true,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: true,
});
