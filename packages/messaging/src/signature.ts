import { createHmac, timingSafeEqual } from "node:crypto";

const signaturePattern = /^t=(\d+),v1=([a-fA-F0-9]+)$/;

export function signBlooioWebhook(input: {
  body: string;
  secret: string;
  timestamp: number;
}): string {
  const digest = createHmac("sha256", input.secret)
    .update(`${input.timestamp}.${input.body}`)
    .digest("hex");
  return `t=${input.timestamp},v1=${digest}`;
}

export function verifyBlooioWebhook(input: {
  body: string;
  header: string | null;
  secret: string;
  now?: number;
  toleranceMs?: number;
}): { timestamp: number } {
  if (!input.header) throw new Error("Missing X-Blooio-Signature header.");
  const match = signaturePattern.exec(input.header.trim());
  if (!match?.[1] || !match[2]) throw new Error("Malformed Blooio signature.");

  const timestamp = Number(match[1]);
  const now = input.now ?? Date.now();
  const toleranceMs = input.toleranceMs ?? 5 * 60 * 1000;
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(now - timestamp * 1000) > toleranceMs
  ) {
    throw new Error(
      "Blooio signature timestamp is outside the allowed window.",
    );
  }

  const expected = signBlooioWebhook({
    body: input.body,
    secret: input.secret,
    timestamp,
  }).slice(input.header.indexOf("v1=") + 3);
  const actual = match[2].toLowerCase();
  const expectedBytes = Buffer.from(expected, "hex");
  const actualBytes = Buffer.from(actual, "hex");
  if (
    expectedBytes.length !== actualBytes.length ||
    !timingSafeEqual(expectedBytes, actualBytes)
  ) {
    throw new Error("Invalid Blooio webhook signature.");
  }
  return { timestamp };
}
