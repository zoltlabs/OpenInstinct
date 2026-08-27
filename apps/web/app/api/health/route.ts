import { OpenInstinctStore } from "@openinstinct/db";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl)
    return NextResponse.json({ ok: false, database: false }, { status: 503 });
  const store = new OpenInstinctStore(databaseUrl, { max: 1 });
  try {
    const database = await store.health();
    return NextResponse.json(
      { ok: database, database, service: "openinstinct-web" },
      { status: database ? 200 : 503 },
    );
  } catch {
    return NextResponse.json({ ok: false, database: false }, { status: 503 });
  } finally {
    await store.close();
  }
}
