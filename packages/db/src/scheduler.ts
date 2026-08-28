import postgres from "postgres";
import { z } from "zod";

export const supabaseSchedulerConfigSchema = z.object({
  consumerUrl: z.url().refine((value) => new URL(value).protocol === "https:", {
    message: "Consumer URL must use HTTPS.",
  }),
  internalApiSecret: z.string().min(32),
});

export async function configureSupabaseScheduler(input: {
  databaseUrl: string;
  consumerUrl: string;
  internalApiSecret: string;
}): Promise<{ jobId: number }> {
  const config = supabaseSchedulerConfigSchema.parse(input);
  const sql = postgres(input.databaseUrl, {
    max: 1,
    prepare: false,
    ssl: input.databaseUrl.includes("localhost") ? false : "require",
  });
  try {
    const [row] = await sql<{ job_id: number | string }[]>`
      select app_private.configure_consumer_scheduler(
        ${config.consumerUrl},
        ${config.internalApiSecret}
      ) as job_id
    `;
    if (!row) throw new Error("Supabase did not return a scheduler job ID.");
    return { jobId: Number(row.job_id) };
  } finally {
    await sql.end();
  }
}
