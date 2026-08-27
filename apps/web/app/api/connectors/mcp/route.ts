import { randomUUID } from "node:crypto";
import { connectRemoteMcp } from "@openinstinct/connectors";
import { encryptCredential, OpenInstinctStore } from "@openinstinct/db";
import { NextResponse } from "next/server";
import { requireOwner } from "../../../../src/lib/owner";
import { isSameOrigin } from "../../../../src/lib/request-security";

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return NextResponse.json({ error: "Invalid origin." }, { status: 403 });
  const { workspace } = await requireOwner();
  if (!workspace)
    return NextResponse.json(
      { error: "Complete onboarding first." },
      { status: 409 },
    );
  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim();
  const url = String(form.get("url") ?? "").trim();
  const bearerToken = String(form.get("bearerToken") ?? "").trim() || undefined;
  if (!name || !url)
    return NextResponse.json(
      { error: "Name and URL are required." },
      { status: 400 },
    );
  const client = await connectRemoteMcp({ url, bearerToken });
  let toolNames: string[];
  try {
    toolNames = Object.keys(await client.tools());
  } finally {
    await client.close();
  }
  const databaseUrl = process.env.DATABASE_URL;
  const encryptionKey = process.env.SECRET_ENCRYPTION_KEY;
  if (!databaseUrl || !encryptionKey)
    throw new Error("Server credential storage is not configured.");
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
  } finally {
    await store.close();
  }
  return NextResponse.redirect(new URL("/?connected=mcp", request.url), 303);
}
