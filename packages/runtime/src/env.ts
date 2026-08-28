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
  AI_GATEWAY_API_KEY: z.string().min(1),
  AI_MODEL: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REDIRECT_URI: secureUrl,
  KERNEL_API_KEY: z.string().min(1),
  INTERNAL_API_SECRET: z.string().min(32),
  CRON_SECRET: z.string().min(16),
  WORKER_URL: secureUrl,
} as const;

export const serverEnvironmentSchema = z.object({
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
  AI_GATEWAY_API_KEY: environmentFieldSchemas.AI_GATEWAY_API_KEY.optional(),
  AI_MODEL: environmentFieldSchemas.AI_MODEL,
  GOOGLE_CLIENT_ID: environmentFieldSchemas.GOOGLE_CLIENT_ID.optional(),
  GOOGLE_CLIENT_SECRET: environmentFieldSchemas.GOOGLE_CLIENT_SECRET.optional(),
  GOOGLE_REDIRECT_URI: optionalUrl,
  KERNEL_API_KEY: environmentFieldSchemas.KERNEL_API_KEY.optional(),
  INTERNAL_API_SECRET: environmentFieldSchemas.INTERNAL_API_SECRET,
  CRON_SECRET: environmentFieldSchemas.CRON_SECRET.optional(),
  WORKER_URL: optionalUrl,
});

export type ServerEnvironment = z.infer<typeof serverEnvironmentSchema>;

export function readServerEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): ServerEnvironment {
  return serverEnvironmentSchema.parse({
    ...source,
    SUPABASE_URL: source.SUPABASE_URL ?? source.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY:
      source.SUPABASE_PUBLISHABLE_KEY ??
      source.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
}

export const publicEnvironmentSchema = serverEnvironmentSchema.pick({
  NEXT_PUBLIC_APP_URL: true,
  NEXT_PUBLIC_SUPABASE_URL: true,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: true,
});
