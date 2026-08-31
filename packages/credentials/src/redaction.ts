export type SensitiveMessageKind =
  | "otp"
  | "password_reset"
  | "recovery"
  | "security_challenge";

const sensitivePatterns: readonly [SensitiveMessageKind, RegExp][] = [
  [
    "otp",
    /\b(?:otp|one[- ]time|verification|security)\s+(?:code|pin)\b|\b(?:your|the|login|sign[- ]?in|authentication)?\s*(?:verification|security|access)?\s*(?:code|pin)\s*(?:is|:)\s*\d{4,8}\b|\b\d{4,8}\b.{0,40}\b(?:expires?|minutes?)\b/isu,
  ],
  [
    "password_reset",
    /\b(?:reset|change|forgot).{0,40}\bpassword\b|\bpassword.{0,40}\breset\b/isu,
  ],
  ["recovery", /\b(?:recovery|backup)\s+(?:code|key)|\baccount recovery\b/isu],
  [
    "security_challenge",
    /\b(?:new sign[- ]?in|unusual activity|security challenge|confirm (?:it'?s|your) identity)\b/isu,
  ],
];

export function classifySensitiveMessage(
  value: string,
): SensitiveMessageKind | undefined {
  if (
    /https?:\/\/[^\s<>"']{1,2000}(?:\/(?:magic|verify|verification|reset|recovery)(?:[-_/?#]|$)|[?&](?:token|code|otp|magic|verify|verification|reset|recovery)=[^\s&<>"']+)/iu.test(
      value,
    )
  )
    return "security_challenge";
  if (
    /\b(?:use|enter)?\s*(?:your|the)?\s*(?:login|sign[- ]?in|verification|security|authentication|access|one[- ]time)\s*(?:code|pin)\s*(?:is|:)?\s*[a-z0-9][a-z0-9-]{3,31}\b/iu.test(
      value,
    )
  )
    return "otp";
  if (
    /\b\d{4,8}\b/u.test(value) &&
    /\b(?:code|pin|otp|verify|verification|login|sign[- ]?in|authentication|security|access)\b/iu.test(
      value,
    )
  )
    return "otp";
  return sensitivePatterns.find(([, pattern]) => pattern.test(value))?.[0];
}

export function filterSensitiveMessage(
  value: string,
):
  | { disposition: "allow"; text: string }
  | { disposition: "owner_handoff"; kind: SensitiveMessageKind; text: string } {
  const kind = classifySensitiveMessage(value);
  if (!kind) return { disposition: "allow", text: value };
  return {
    disposition: "owner_handoff",
    kind,
    text: `[${kind.toUpperCase()} CONTENT WITHHELD — OWNER TAKEOVER REQUIRED]`,
  };
}

export function filterSensitiveMessageTree(value: unknown): unknown {
  if (typeof value === "string") return filterSensitiveMessage(value).text;
  if (Array.isArray(value)) return value.map(filterSensitiveMessageTree);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        filterSensitiveMessageTree(entry),
      ]),
    );
  return value;
}

const GMAIL_MAX_PARTS = 100;
const GMAIL_MAX_DECODED_BYTES = 1_000_000;

export function sanitizeGmailMessage(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return withheldGmailMessage(value, "security_challenge");
  const message = value as Record<string, unknown>;
  const samples: string[] = [];
  const decodedBodies: string[] = [];
  if (typeof message.snippet === "string") samples.push(message.snippet);
  let parts = 0;
  let decodedBytes = 0;
  let malformed = false;
  const visit = (candidate: unknown, depth: number): void => {
    if (
      malformed ||
      depth > 10 ||
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      if (depth > 10) malformed = true;
      return;
    }
    parts += 1;
    if (parts > GMAIL_MAX_PARTS) {
      malformed = true;
      return;
    }
    const part = candidate as Record<string, unknown>;
    if (Array.isArray(part.headers))
      for (const header of part.headers) {
        if (!header || typeof header !== "object") continue;
        const raw = header as Record<string, unknown>;
        if (typeof raw.value === "string") samples.push(raw.value);
      }
    const body = part.body;
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const data = (body as Record<string, unknown>).data;
      if (typeof data === "string" && data.length > 0) {
        if (!/^[A-Za-z0-9_-]+={0,2}$/u.test(data)) malformed = true;
        else {
          const decoded = Buffer.from(data, "base64url");
          decodedBytes += decoded.byteLength;
          if (decodedBytes > GMAIL_MAX_DECODED_BYTES) malformed = true;
          else {
            const text = decoded.toString("utf8");
            decodedBodies.push(text);
            samples.push(text);
          }
          decoded.fill(0);
        }
      }
    }
    if (Array.isArray(part.parts))
      for (const child of part.parts) visit(child, depth + 1);
  };
  visit(message.payload, 0);
  const classificationText = samples
    .flatMap((sample) => [
      normalizeMessageText(sample, " "),
      normalizeMessageText(sample, ""),
    ])
    .join("\n");
  const kind = malformed
    ? "security_challenge"
    : classifySensitiveMessage(classificationText);
  return kind
    ? withheldGmailMessage(message, kind)
    : sanitizedGmailMessage(
        message,
        decodedBodies.map((body) => normalizeMessageText(body, " ")).join("\n"),
      );
}

function normalizeMessageText(value: string, tagSeparator: string): string {
  return value
    .replace(/<[^>]{0,1000}>/gu, tagSeparator)
    .replace(/&(?:nbsp|#160);/giu, " ")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&amp;/giu, "&")
    .replace(/=([0-9A-F]{2})/giu, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\s+/gu, " ")
    .trim();
}

function sanitizedGmailMessage(
  message: Record<string, unknown>,
  content: string,
): Record<string, unknown> {
  return {
    ...(typeof message.id === "string" ? { id: message.id } : {}),
    ...(typeof message.threadId === "string"
      ? { threadId: message.threadId }
      : {}),
    ...(typeof message.internalDate === "string"
      ? { internalDate: message.internalDate }
      : {}),
    ...(Array.isArray(message.labelIds)
      ? {
          labelIds: message.labelIds.filter(
            (entry): entry is string => typeof entry === "string",
          ),
        }
      : {}),
    content: content.slice(0, GMAIL_MAX_DECODED_BYTES),
  };
}

function withheldGmailMessage(
  value: unknown,
  kind: SensitiveMessageKind,
): Record<string, unknown> {
  const message =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    ...(typeof message.id === "string" ? { id: message.id } : {}),
    ...(typeof message.threadId === "string"
      ? { threadId: message.threadId }
      : {}),
    ...(typeof message.internalDate === "string"
      ? { internalDate: message.internalDate }
      : {}),
    ...(Array.isArray(message.labelIds)
      ? {
          labelIds: message.labelIds.filter(
            (entry): entry is string => typeof entry === "string",
          ),
        }
      : {}),
    sensitiveContent: {
      disposition: "owner_handoff",
      kind,
      text: `[${kind.toUpperCase()} CONTENT WITHHELD — OWNER TAKEOVER REQUIRED]`,
    },
  };
}
