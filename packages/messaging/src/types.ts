import { z } from "zod";

export const blooioMessageDataSchema = z
  .object({
    message_id: z.string().min(1).max(256),
    chat_id: z.string().min(1).max(256),
    channel_id: z.string().max(256).optional(),
    channel_address: z.string().max(256).optional(),
    direction: z.enum(["inbound", "outbound"]),
    kind: z.string().max(64),
    text: z.string().max(100_000).nullable().optional(),
    sender: z.string().max(256).optional(),
    recipient: z.string().max(256).optional(),
    status: z.string().max(64).optional(),
    protocol: z.string().max(64).optional(),
    message_type: z.string().max(64).optional(),
    attachments: z
      .array(z.record(z.string().max(128), z.unknown()))
      .max(20)
      .default([]),
    error: z
      .object({ code: z.string().optional(), message: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const blooioWebhookEventSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.string().min(1).max(128),
    created_at: z.number().int(),
    organization_id: z.string().min(1).max(256),
    data: z.record(z.string(), z.unknown()),
  })
  .passthrough();

export const sendMessageInputSchema = z.object({
  to: z.string().min(1),
  text: z.string().min(1),
  channelId: z.string().min(1).optional(),
  idempotencyKey: z.string().min(8),
});

export const sendMessageResultSchema = z
  .object({
    message_id: z.string().min(1),
    status: z.string(),
  })
  .passthrough();

export type BlooioWebhookEvent = z.infer<typeof blooioWebhookEventSchema>;
export type SendMessageInput = z.infer<typeof sendMessageInputSchema>;
export type SendMessageResult = z.infer<typeof sendMessageResultSchema>;
