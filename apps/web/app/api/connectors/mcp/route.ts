import { randomUUID } from "node:crypto";
import { connectRemoteMcp } from "@openinstinct/connectors";
import { encryptCredential, OpenInstinctStore } from "@openinstinct/db";
import { NextResponse } from "next/server";
import { requireOwner } from "../../../../src/lib/owner";
import { isSameOrigin } from "../../../../src/lib/request-security";
import { feedbackUrl } from "../../../../src/lib/feedback";

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return NextResponse.json({ error: "Invalid origin." }, { status: 403 });
  const { workspace } = await requireOwner();
  if (!workspace)
    return NextResponse.redirect(
      feedbackUrl(request.url, "session-expired"),
      303,
    );
  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim();
  const url = String(form.get("url") ?? "").trim();
  const bearerToken = String(form.get("bearerToken") ?? "").trim() || undefined;
  if (!name || !url)
    return NextResponse.redirect(feedbackUrl(request.url, "mcp-invalid"), 303);
  let client;
  try {
    client = await connectRemoteMcp({ url, bearerToken });
  } catch {
    return NextResponse.redirect(feedbackUrl(request.url, "mcp-failed"), 303);
  }
  let toolNames: string[];
  try {
    toolNames = Object.keys(await client.tools());
  } catch {
    return NextResponse.redirect(feedbackUrl(request.url, "mcp-failed"), 303);
  } finally {
    await client.close().catch(() => undefined);
  }
  const databaseUrl = process.env.DATABASE_URL;
  const encryptionKey = process.env.SECRET_ENCRYPTION_KEY;
  if (!databaseUrl || !encryptionKey)
    return NextResponse.redirect(
      feedbackUrl(request.url, "configuration-incomplete"),
      303,
    );
  const connectionId = randomUUID();
  const configVersion = randomUUID();
  const store = new OpenInstinctStore(databaseUrl);
  try {
    await store.upsertConnection({
      id: connectionId,
      workspaceId: workspace.id,
      provider: "mcp",
      accountId: url,
      displayName: name,
      scopes: toolNames,
      encryptedCredentials: encryptCredential({
        plaintext: JSON.stringify({ bearerToken }),
        encodedKey: encryptionKey,
        workspaceId: workspace.id,
        connectionId,
      }),
      metadata: { url, toolNames, configVersion, policy: "approval_required" },
    });
  } catch {
    return NextResponse.redirect(feedbackUrl(request.url, "mcp-failed"), 303);
  } finally {
    await store.close();
  }
  return NextResponse.redirect(feedbackUrl(request.url, "mcp-connected"), 303);
}
