import { randomUUID } from "node:crypto";
import {
  browserReadObservationHash,
  browserReadObservationSchema,
  canonicalBrowserReadUrl,
  type BrowserReadObservation,
} from "@openinstinct/core";
import type { BrowserObservation } from "./provider";

export const browserRedactionVersion = "semantic-v1";

const suspiciousContent =
  /(?:ignore|override|disregard).{0,80}(?:instruction|policy|system|developer)|(?:system|developer)\s+(?:message|prompt)|reveal.{0,50}(?:secret|credential|token)|(?:enter|provide|send|upload).{0,50}(?:password|passcode|otp|one[- ]time|recovery code|api key)|captcha|verify you are human/isu;
const invisibleControls = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/gu;
const credentialPatterns: readonly [RegExp, string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu, "[REDACTED_TOKEN]"],
  [
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
    "[REDACTED_TOKEN]",
  ],
  [
    /\b(?:sk|pk|api|key|token|secret)[-_][A-Za-z0-9_-]{12,}\b/giu,
    "[REDACTED_SECRET]",
  ],
  [
    /((?:password|passcode|secret|api[_ -]?key|access[_ -]?token))\s*[:=]\s*\S+/giu,
    "$1=[REDACTED]",
  ],
  [
    /((?:otp|one[- ]time code|verification code|recovery code))\D{0,12}\b\d{4,10}\b/giu,
    "$1 [REDACTED_CODE]",
  ],
  [/\b(?:\d[ -]*?){13,19}\b/gu, "[REDACTED_PAYMENT_NUMBER]"],
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[REDACTED_EMAIL]"],
];

export function redactBrowserText(value: string, maxLength: number): string {
  let redacted = value.replace(invisibleControls, "");
  for (const [pattern, replacement] of credentialPatterns)
    redacted = redacted.replace(pattern, replacement);
  return redacted
    .replace(/\s{4,}/gu, "   ")
    .trim()
    .slice(0, maxLength);
}

export function isSuspiciousBrowserContent(value: string): boolean {
  return suspiciousContent.test(value.replace(invisibleControls, ""));
}

export function redactBrowserObservation(
  raw: BrowserObservation,
  screenshot?: { hash?: string; omittedReason?: string },
): BrowserReadObservation {
  const current = publicBrowserUrl(raw.url);
  const rawCombined = `${raw.title}\n${raw.text}\n${raw.links
    .map((link) => link.text)
    .join("\n")}`;
  const links = raw.links.flatMap((link) => {
    try {
      const hrefUrl = publicBrowserUrl(link.href);
      if (hasSensitivePath(hrefUrl.pathname)) return [];
      const href = hrefUrl.toString().slice(0, 1_500);
      const text = redactBrowserText(link.text, 300);
      return [
        {
          text,
          href,
          hrefHash: browserReadObservationHash({
            origin: new URL(href).origin,
            path: new URL(href).pathname,
            title: "",
            text: "",
            links: [],
            tabCount: 1,
            suspicious: false,
            redactionVersion: browserRedactionVersion,
          }),
        },
      ];
    } catch {
      return [];
    }
  });
  const base = {
    origin: current.origin,
    path: hasSensitivePath(current.pathname)
      ? "/[REDACTED_SENSITIVE_PATH]"
      : current.pathname.slice(0, 1_000),
    title: redactBrowserText(raw.title, 500),
    text: redactBrowserText(raw.text, 12_000),
    links: links.slice(0, 12),
    tabCount: Math.max(1, Math.min(raw.tabCount ?? 1, 5)),
    suspicious: isSuspiciousBrowserContent(rawCombined),
    redactionVersion: browserRedactionVersion,
    ...(screenshot?.hash ? { screenshotHash: screenshot.hash } : {}),
    ...(screenshot?.omittedReason
      ? { screenshotOmittedReason: screenshot.omittedReason }
      : {}),
  };
  return browserReadObservationSchema.parse({
    id: randomUUID(),
    ...base,
    hash: browserReadObservationHash(base),
  });
}

const sensitivePathWord =
  /(?:reset|recover|verify|magic|invite|activate|callback|oauth|token|secret|session|credential)/iu;
const highEntropySegment = /(?=.{20,})(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_-]+/u;

function hasSensitivePath(pathname: string): boolean {
  return pathname
    .split("/")
    .some(
      (segment) =>
        sensitivePathWord.test(segment) || highEntropySegment.test(segment),
    );
}

function publicBrowserUrl(rawUrl: string): URL {
  const parsed = new URL(rawUrl);
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return canonicalBrowserReadUrl(parsed.toString());
}
