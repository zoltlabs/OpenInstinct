import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { oauthTokenSetSchema, type OAuthTokenSet } from "./types";

export const googleScopes = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar",
] as const;

export interface GoogleOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

export function createGoogleAuthorization(config: GoogleOAuthConfig): {
  url: string;
  state: string;
  codeVerifier: string;
} {
  const state = randomBytes(24).toString("base64url");
  const codeVerifier = randomBytes(48).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    access_type: "offline",
    client_id: config.clientId,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    include_granted_scopes: "true",
    prompt: "consent",
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: googleScopes.join(" "),
    state,
  }).toString();
  return { url: url.toString(), state, codeVerifier };
}

const googleTokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

export async function exchangeGoogleCode(input: {
  code: string;
  codeVerifier: string;
  config: GoogleOAuthConfig;
  fetch?: typeof fetch;
}): Promise<OAuthTokenSet> {
  return requestGoogleToken(
    {
      client_id: input.config.clientId,
      client_secret: input.config.clientSecret,
      code: input.code,
      code_verifier: input.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: input.config.redirectUri,
    },
    input.fetch,
  );
}

export async function refreshGoogleToken(input: {
  refreshToken: string;
  config: GoogleOAuthConfig;
  fetch?: typeof fetch;
}): Promise<OAuthTokenSet> {
  const refreshed = await requestGoogleToken(
    {
      client_id: input.config.clientId,
      client_secret: input.config.clientSecret,
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
    },
    input.fetch,
  );
  return { ...refreshed, refreshToken: input.refreshToken };
}

async function requestGoogleToken(
  params: Record<string, string>,
  request: typeof fetch = fetch,
): Promise<OAuthTokenSet> {
  const response = await request("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const raw: unknown = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      `Google OAuth exchange failed with HTTP ${response.status}.`,
    );
  const token = googleTokenResponseSchema.parse(raw);
  return oauthTokenSetSchema.parse({
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
    scope: token.scope,
    tokenType: token.token_type ?? "Bearer",
  });
}

export class GoogleConnector {
  readonly #accessToken: string;
  readonly #fetch: typeof fetch;

  constructor(input: { accessToken: string; fetch?: typeof fetch }) {
    this.#accessToken = input.accessToken;
    this.#fetch = input.fetch ?? fetch;
  }

  async searchGmail(query: string, maxResults = 10): Promise<unknown> {
    const url = new URL(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages",
    );
    url.search = new URLSearchParams({
      q: query,
      maxResults: String(maxResults),
    }).toString();
    return this.#request(url);
  }

  async getGmailMessage(messageId: string): Promise<unknown> {
    return this.#request(
      new URL(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
      ),
    );
  }

  async createGmailDraft(input: {
    to: string;
    subject: string;
    body: string;
    idempotencyMarker?: string;
  }): Promise<unknown> {
    const raw = Buffer.from(
      [
        `To: ${input.to}`,
        `Subject: ${input.subject}`,
        ...(input.idempotencyMarker
          ? [`Message-ID: <${input.idempotencyMarker}@openinstinct.local>`]
          : []),
        "Content-Type: text/plain; charset=utf-8",
        "",
        input.body,
      ].join("\r\n"),
    ).toString("base64url");
    return this.#request(
      new URL("https://gmail.googleapis.com/gmail/v1/users/me/drafts"),
      { method: "POST", body: JSON.stringify({ message: { raw } }) },
    );
  }

  async searchGmailDrafts(query: string, maxResults = 10): Promise<unknown> {
    const url = new URL(
      "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
    );
    url.search = new URLSearchParams({
      q: query,
      maxResults: String(maxResults),
    }).toString();
    return this.#request(url);
  }

  async getGmailDraft(draftId: string): Promise<unknown> {
    return this.#request(
      new URL(
        `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(draftId)}?format=raw`,
      ),
    );
  }

  async listCalendarEvents(input: {
    timeMin: string;
    timeMax: string;
    maxResults?: number;
  }): Promise<unknown> {
    const url = new URL(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    );
    url.search = new URLSearchParams({
      singleEvents: "true",
      orderBy: "startTime",
      timeMin: input.timeMin,
      timeMax: input.timeMax,
      maxResults: String(input.maxResults ?? 20),
    }).toString();
    return this.#request(url);
  }

  async createCalendarEvent(input: {
    id?: string;
    summary: string;
    description?: string;
    start: { dateTime: string; timeZone?: string };
    end: { dateTime: string; timeZone?: string };
    attendees?: readonly string[];
  }): Promise<unknown> {
    return this.#request(
      new URL(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all",
      ),
      {
        method: "POST",
        body: JSON.stringify({
          id: input.id,
          summary: input.summary,
          description: input.description,
          start: input.start,
          end: input.end,
          attendees: input.attendees?.map((email) => ({ email })),
        }),
      },
    );
  }

  async getCalendarEvent(eventId: string): Promise<unknown> {
    return this.#request(
      new URL(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
      ),
    );
  }

  async #request(url: URL, init: RequestInit = {}): Promise<unknown> {
    const response = await this.#fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.#accessToken}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok) throw new GoogleApiError(response.status);
    return body;
  }
}

export class GoogleApiError extends Error {
  constructor(readonly status: number) {
    super(`Google API request failed with HTTP ${status}.`);
    this.name = "GoogleApiError";
  }
}
