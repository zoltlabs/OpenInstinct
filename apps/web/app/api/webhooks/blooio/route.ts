import { OpenInstinctStore } from "@openinstinct/db";
import {
  blooioWebhookEventSchema,
  verifyBlooioWebhook,
} from "@openinstinct/messaging";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
const MAX_WEBHOOK_BYTES = 256 * 1024;

async function readLimitedBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES)
    throw new RangeError("Webhook body is too large.");
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_WEBHOOK_BYTES) {
      await reader.cancel();
      throw new RangeError("Webhook body is too large.");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export async function POST(request: Request) {
  const secret = process.env.BLOOIO_WEBHOOK_SECRET;
  const databaseUrl = process.env.DATABASE_URL;
  if (!secret || !databaseUrl)
    return NextResponse.json(
      { error: "Webhook is not configured." },
      { status: 503 },
    );
  let body: string;
  try {
    body = await readLimitedBody(request);
  } catch (error) {
    if (error instanceof RangeError)
      return NextResponse.json({ error: error.message }, { status: 413 });
    throw error;
  }
  try {
    verifyBlooioWebhook({
      body,
      header:
        request.headers.get("x-blooio-signature") ??
        request.headers.get("blooio-signature"),
      secret,
    });
  } catch {
    return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const parsed = blooioWebhookEventSchema.safeParse(json);
  if (!parsed.success)
    return NextResponse.json({ error: "Invalid event." }, { status: 400 });
  const store = new OpenInstinctStore(databaseUrl);
  try {
    const result = await store.ingestBlooioEvent(parsed.data);
    return NextResponse.json(result, { status: result.duplicate ? 200 : 202 });
  } finally {
    await store.close();
  }
}
