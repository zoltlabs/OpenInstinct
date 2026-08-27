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

export const serverEnvironmentSchema = z.object({
  NEXT_PUBLIC_APP_URL: secureUrl,
  NEXT_PUBLIC_SUPABASE_URL: secureUrl,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_URL: optionalUrl,
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
  SUPABASE_SECRET_KEY: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  SECRET_ENCRYPTION_KEY: z.string().min(1),
  BLOOIO_API_KEY: z.string().min(1),
  BLOOIO_WEBHOOK_SECRET: z.string().min(1),
  BLOOIO_CHANNEL_ID: z.string().min(1).optional(),
  BLOOIO_OWNER_PHONE: z.string().regex(/^\+[1-9][0-9]{7,14}$/),
  OWNER_EMAIL: z.string().email(),
  AI_GATEWAY_API_KEY: z.string().min(1).optional(),
  AI_MODEL: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_REDIRECT_URI: optionalUrl,
  KERNEL_API_KEY: z.string().min(1).optional(),
  INTERNAL_API_SECRET: z.string().min(32),
  CRON_SECRET: z.string().min(16).optional(),
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
