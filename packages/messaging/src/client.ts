import {
  sendMessageInputSchema,
  sendMessageResultSchema,
  type SendMessageInput,
  type SendMessageResult,
} from "./types";

export class BlooioApiError extends Error {
  readonly code?: string;
  readonly status: number;

  constructor(input: { status: number; code?: string; message: string }) {
    super(input.message);
    this.name = "BlooioApiError";
    this.status = input.status;
    this.code = input.code;
  }
}

export class BlooioClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(input: {
    apiKey: string;
    baseUrl?: string;
    fetch?: typeof fetch;
  }) {
    this.#apiKey = input.apiKey;
    this.#baseUrl = input.baseUrl ?? "https://api.blooio.com/v4";
    this.#fetch = input.fetch ?? fetch;
  }

  async sendMessage(rawInput: SendMessageInput): Promise<SendMessageResult> {
    const input = sendMessageInputSchema.parse(rawInput);
    const response = await this.#fetch(`${this.#baseUrl}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": input.idempotencyKey,
      },
      body: JSON.stringify({
        to: input.to,
        text: input.text,
        ...(input.channelId ? { from: input.channelId } : {}),
      }),
    });
    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const value = body as {
        code?: unknown;
        message?: unknown;
        error?: unknown;
      };
      throw new BlooioApiError({
        status: response.status,
        code: typeof value.code === "string" ? value.code : undefined,
        message:
          typeof value.message === "string"
            ? value.message
            : typeof value.error === "string"
              ? value.error
              : `Blooio request failed with HTTP ${response.status}.`,
      });
    }
    const envelope = body as { data?: unknown };
    return sendMessageResultSchema.parse(envelope.data ?? body);
  }

  async createWebhook(url: string): Promise<{
    id: string;
    signingSecret: string;
  }> {
    const response = await this.#fetch(`${this.#baseUrl}/webhooks`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url }),
    });
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!response.ok) {
      throw new BlooioApiError({
        status: response.status,
        code: typeof body.code === "string" ? body.code : undefined,
        message:
          typeof body.message === "string"
            ? body.message
            : `Could not create Blooio webhook (HTTP ${response.status}).`,
      });
    }
    const data =
      body.data && typeof body.data === "object"
        ? (body.data as Record<string, unknown>)
        : body;
    const id = data.id ?? data.webhook_id;
    const secret = data.signing_secret;
    if (typeof id !== "string" || typeof secret !== "string") {
      throw new Error(
        "Blooio webhook response did not contain its one-time signing secret.",
      );
    }
    return { id, signingSecret: secret };
  }
}

const waitForRecipientCodes = new Set([
  "conversation_awaiting_reply",
  "conversation_streak_limit",
  "conversation_inactive_paused",
]);

const permanentCodes = new Set([
  "conversation_content_restricted",
  "safety_new_conversations_paused",
  "safety_reply_only",
  "safety_account_review",
]);

export function classifyBlooioError(
  error: BlooioApiError,
): "wait_for_recipient" | "blocked" | "retry" | "fatal" {
  if (error.code && waitForRecipientCodes.has(error.code))
    return "wait_for_recipient";
  if (error.code && permanentCodes.has(error.code)) return "blocked";
  if (error.status === 429 || error.status >= 500) return "retry";
  return "fatal";
}
