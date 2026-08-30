import { readFile } from "node:fs/promises";
import { BlooioClient, type BlooioChannel } from "@openinstinct/messaging";
import { environmentFieldSchemas } from "@openinstinct/runtime";
import { envFileValues, pathExists, setEnvValues } from "./env-file";

export interface BlooioSetupResult {
  readonly channels: BlooioChannel[];
  readonly selectedChannelId?: string;
}

export async function configureBlooio(input: {
  envPath: string;
  apiKey: string;
  channelId?: string;
  fetch?: typeof fetch;
}): Promise<BlooioSetupResult> {
  const apiKey = environmentFieldSchemas.BLOOIO_API_KEY.parse(input.apiKey);
  const channels = await new BlooioClient({
    apiKey,
    fetch: input.fetch,
  }).listActiveChannels();
  if (channels.length === 0)
    throw new Error(
      "Blooio access is valid, but no active Blooio number is assigned to this API key.",
    );

  let selectedChannelId = input.channelId;
  if (selectedChannelId) {
    environmentFieldSchemas.BLOOIO_CHANNEL_ID.parse(selectedChannelId);
    if (!channels.some((channel) => channel.id === selectedChannelId))
      throw new Error(
        "The selected Blooio channel is not active or is not assigned to this API key.",
      );
  } else if (channels.length === 1) {
    selectedChannelId = channels[0]?.id;
  }

  await setEnvValues(input.envPath, {
    BLOOIO_API_KEY: apiKey,
    ...(selectedChannelId ? { BLOOIO_CHANNEL_ID: selectedChannelId } : {}),
  });
  return { channels, selectedChannelId };
}

export async function ensureBlooioWebhook(input: {
  envPath: string;
  appUrl: string;
  fetch?: typeof fetch;
}): Promise<{
  webhookId: string;
  operation: "created" | "reused" | "rotated";
  secretCaptured: boolean;
}> {
  const appUrl = environmentFieldSchemas.NEXT_PUBLIC_APP_URL.parse(
    input.appUrl,
  );
  const parsedAppUrl = new URL(appUrl);
  if (
    parsedAppUrl.protocol !== "https:" ||
    ["localhost", "127.0.0.1", "::1"].includes(parsedAppUrl.hostname)
  )
    throw new Error("Blooio webhooks require a public HTTPS URL.");

  const values = (await pathExists(input.envPath))
    ? envFileValues(await readFile(input.envPath, "utf8"))
    : {};
  const apiKey = environmentFieldSchemas.BLOOIO_API_KEY.parse(
    process.env.BLOOIO_API_KEY ?? values.BLOOIO_API_KEY,
  );
  const targetUrl = new URL("/api/webhooks/blooio", parsedAppUrl).toString();
  const client = new BlooioClient({ apiKey, fetch: input.fetch });
  const matching = (await client.listWebhooks()).filter(
    (webhook) => webhook.url === targetUrl && webhook.status === "active",
  );
  if (matching.length > 1)
    throw new Error(
      "Multiple active Blooio webhooks target this URL. Remove the duplicates in Blooio before continuing.",
    );

  const existing = matching[0];
  if (existing && values.BLOOIO_WEBHOOK_SECRET)
    return {
      webhookId: existing.id,
      operation: "reused",
      secretCaptured: false,
    };

  if (existing) {
    const rotated = await client.rotateWebhookSecret(existing.id);
    await setEnvValues(input.envPath, {
      BLOOIO_WEBHOOK_SECRET: rotated.signingSecret,
    });
    return {
      webhookId: existing.id,
      operation: "rotated",
      secretCaptured: true,
    };
  }

  const created = await client.createWebhook(targetUrl);
  await setEnvValues(input.envPath, {
    BLOOIO_WEBHOOK_SECRET: created.signingSecret,
  });
  return {
    webhookId: created.id,
    operation: "created",
    secretCaptured: true,
  };
}
