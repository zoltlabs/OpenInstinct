import { describe, expect, it, vi } from "vitest";
import {
  BlooioClient,
  classifyBlooioError,
  BlooioApiError,
  signBlooioWebhook,
  verifyBlooioWebhook,
} from "../src/index";

describe("Blooio signatures", () => {
  it("verifies the raw body and timestamp", () => {
    const timestamp = 1_800_000_000;
    const body = '{"id":"evt_1"}';
    const header = signBlooioWebhook({ body, secret: "secret", timestamp });
    expect(
      verifyBlooioWebhook({
        body,
        header,
        secret: "secret",
        now: timestamp * 1000,
      }),
    ).toEqual({ timestamp });
  });

  it("rejects a changed body", () => {
    const timestamp = 1_800_000_000;
    const header = signBlooioWebhook({
      body: "original",
      secret: "secret",
      timestamp,
    });
    expect(() =>
      verifyBlooioWebhook({
        body: "changed",
        header,
        secret: "secret",
        now: timestamp * 1000,
      }),
    ).toThrow(/Invalid/);
  });
});

describe("Blooio client", () => {
  it("sends a stable idempotency key", async () => {
    let sentInit: RequestInit | undefined;
    const request = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        sentInit = init;
        return new Response(
          JSON.stringify({
            data: { message_id: "msg_1", status: "queued" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    );
    const client = new BlooioClient({
      apiKey: "key",
      fetch: request as typeof fetch,
    });
    await client.sendMessage({
      to: "+15555550123",
      text: "Hello",
      idempotencyKey: "action-123",
    });
    expect(sentInit?.headers).toMatchObject({
      "Idempotency-Key": "action-123",
    });
  });

  it("captures the one-time webhook secret from the v4 envelope", async () => {
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: { id: "wh_1", signing_secret: "whsec_secret" },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
    );
    const client = new BlooioClient({
      apiKey: "key",
      fetch: request as typeof fetch,
    });
    await expect(
      client.createWebhook("https://assistant.example/api/webhooks/blooio"),
    ).resolves.toEqual({ id: "wh_1", signingSecret: "whsec_secret" });
  });

  it("does not retry conversation wait codes", () => {
    expect(
      classifyBlooioError(
        new BlooioApiError({
          status: 429,
          code: "conversation_awaiting_reply",
          message: "wait",
        }),
      ),
    ).toBe("wait_for_recipient");
  });
});
