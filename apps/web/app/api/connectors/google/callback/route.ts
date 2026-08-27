import { randomUUID } from "node:crypto";
import { exchangeGoogleCode, googleScopes } from "@openinstinct/connectors";
import { encryptCredential, OpenInstinctStore } from "@openinstinct/db";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { googleConfig } from "../../../../../src/lib/google-config";
import { requireOwner } from "../../../../../src/lib/owner";

export async function GET(request: Request) {
  const { workspace } = await requireOwner();
  if (!workspace) return NextResponse.redirect(new URL("/", request.url));
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieStore = await cookies();
  const expectedState = cookieStore.get("oi_google_state")?.value;
  const verifier = cookieStore.get("oi_google_verifier")?.value;
  cookieStore.delete("oi_google_state");
  cookieStore.delete("oi_google_verifier");
  if (!code || !state || state !== expectedState || !verifier) {
    return NextResponse.json(
      { error: "Invalid Google OAuth state." },
      { status: 400 },
    );
  }
  const token = await exchangeGoogleCode({
    code,
    codeVerifier: verifier,
    config: googleConfig(),
  });
  const profileResponse = await fetch(
    "https://openidconnect.googleapis.com/v1/userinfo",
    {
      headers: { Authorization: `Bearer ${token.accessToken}` },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!profileResponse.ok)
    return NextResponse.json(
      { error: "Could not read Google profile." },
      { status: 502 },
    );
  const profile = (await profileResponse.json()) as {
    sub?: string;
    email?: string;
  };
  if (!profile.sub)
    return NextResponse.json(
      { error: "Google profile is missing an account id." },
      { status: 502 },
    );
  const connectionId = randomUUID();
  const configVersion = randomUUID();
  const databaseUrl = process.env.DATABASE_URL;
  const encryptionKey = process.env.SECRET_ENCRYPTION_KEY;
  if (!databaseUrl || !encryptionKey)
    throw new Error("Server credential storage is not configured.");
  const store = new OpenInstinctStore(databaseUrl);
  try {
    await store.upsertConnection({
      id: connectionId,
      workspaceId: workspace.id,
      provider: "google",
      accountId: profile.sub,
      displayName: profile.email ?? "Google",
      scopes: googleScopes,
      encryptedCredentials: encryptCredential({
        plaintext: JSON.stringify(token),
        encodedKey: encryptionKey,
        workspaceId: workspace.id,
        connectionId,
      }),
      metadata: { accountId: profile.sub, email: profile.email, configVersion },
    });
  } finally {
    await store.close();
  }
  return NextResponse.redirect(new URL("/?connected=google", request.url));
}
