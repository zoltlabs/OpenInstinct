import { OpenInstinctStore } from "@openinstinct/db";
import { readServerEnvironment } from "@openinstinct/runtime";
import { consumeJobs, JobProcessor } from "@openinstinct/worker";
import { NextResponse } from "next/server";

export const maxDuration = 60;
export const runtime = "nodejs";

async function consume(request: Request) {
  const env = readServerEnvironment();
  const authorization = request.headers.get("authorization");
  const authorized =
    authorization === `Bearer ${env.INTERNAL_API_SECRET}` ||
    Boolean(env.CRON_SECRET && authorization === `Bearer ${env.CRON_SECRET}`);
  if (!authorized) {
    return new NextResponse(null, { status: 401 });
  }
  const store = new OpenInstinctStore(env.DATABASE_URL, { max: 1 });
  try {
    const results = await consumeJobs({
      store,
      processor: new JobProcessor({ store, env }),
      limit: 3,
    });
    return NextResponse.json({ processed: results.length, results });
  } finally {
    await store.close();
  }
}

export const POST = consume;
export const GET = consume;
